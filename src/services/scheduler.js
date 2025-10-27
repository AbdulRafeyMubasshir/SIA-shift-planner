import { supabase } from '../supabaseClient';

// Station-to-worker mapping
const stationWorkerMapping = {
  'Ashford': [
    'Phil Judd SUPERVISOR', // SUPERVISOR
    'Clarence Flanders',
    'Shahryar Ali',
  ],
  'Dover Priory': [
    'Lee Anderson SUPERVISOR', // SUPERVISOR
    'Jay Miller',
  ],
  'Tonbridge': [
    'Ayokanmi Ajayi SUPERVISOR', // SUPERVISOR
    'Lukman Bakare',
    'Beloved Adefemi',
  ],
  'Rainham': [
    'Jake Marsh SUPERVISOR', // SUPERVISOR
    'Tom Homard',
    'Innocent Aniebonam',
  ],
  'Sittingbourne': [
    'Abdulraheem Adebayo SUPERVISOR', // SUPERVISOR
    'Rowland Gbedemah',
    'Deryl D\'Costa',
  ],
  'Faversham': [
    'Christopher Ifijen SUPERVISOR', // SUPERVISOR
    'Ishmael Martin',
  ],
  'Canterbury East': [
    'Josh Drake SUPERVISOR', // SUPERVISOR
    'Amilca Roomaney',
    'Amir Kawa',
    'Emmanuel Ekechukwu',
  ],
  'Chatham': [
    'Harry Morgan SUPERVISOR', // SUPERVISOR
    'Chukwuka Ejim',
    'Tanuj Sharma',
  ],
  'Hastings': [
    'Alexander Rudasingwa SUPERVISOR', // SUPERVISOR
    'Melissa Kelly',
    'Benedict Olaniyi',
    'Natu Okubet',
  ],
  'Strood': [
    'Francis Abosi SUPERVISOR', // SUPERVISOR
    'Daniel Okley',
    'Ishola Ozueigbo',
    'Mariana Mocanu',
    'Richard Bandoma',
  ],
  'Rochester': [
    'Amanpreet Hundal SUPERVISOR', // SUPERVISOR
    'Jamie Bailey',
    'Scott Welfare',
    'Peter John',
  ],
  'Gillingham': [
    'Leighton Lewis SUPERVISOR', // SUPERVISOR
    'Victor Fernandes',
    'Abdulfuhad Adedeji',
    'Kolawole Onabanjo',
  ],
  'Woolwich Arsenal': [
    'Benson Lawani SUPERVISOR', // SUPERVISOR
    'Eric Eifuobhokhan',
    'Oluwasegun Omomehin',
    'David Amara',
  ],
  'Lewisham': [
    'Abdulrahmon Salisu',
  ],
  'Dartford': [
    'Paul Mcmanus SUPERVISOR', // SUPERVISOR
    'Dolamu Sylvester',
    'Taiwo Ama',
    'Opeyemi Olajide',
  ],
};

// Helper functions
const getShiftType = (time) => {
  const startTime = parseInt(time.split('-')[0]);
  if (startTime < 1200) return 'early';
  return 'late';
};

const getShiftDurationInHours = (time) => {
  const [start, end] = time.split('-').map(t => parseInt(t));
  const startMin = Math.floor(start / 100) * 60 + (start % 100);
  const endMin = Math.floor(end / 100) * 60 + (end % 100);
  let duration = (endMin - startMin) / 60;
  if (duration < 0) duration += 24;
  return duration;
};

const getShiftStartInMinutes = (time) => {
  const start = parseInt(time.split('-')[0]);
  return Math.floor(start / 100) * 60 + (start % 100);
};

const getShiftEndInMinutes = (time) => {
  const end = parseInt(time.split('-')[1]);
  return Math.floor(end / 100) * 60 + (end % 100);
};

const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const getAvailableDaysCount = (availabilityByDay) => {
  return daysOfWeek.reduce((count, day) => {
    const preference = availabilityByDay[day];
    return preference === 'any' || preference === 'early' || preference === 'late' ? count + 1 : count;
  }, 0);
};

const hasWeekendAvailability = (availabilityByDay) => {
  const saturday = availabilityByDay.saturday;
  const sunday = availabilityByDay.sunday;
  return (
    (saturday === 'any' || saturday === 'early' || saturday === 'late') ||
    (sunday === 'any' || sunday === 'early' || sunday === 'late')
  );
};

const allocateWorkers = async () => {
  // 🔐 Get session
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !session?.user) {
    throw new Error("User not logged in");
  }

  const userId = session.user.id;

  // 🏢 Get organization_id from profile
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('organization_id')
    .eq('id', userId)
    .single();

  if (profileError || !profile) {
    throw new Error("Could not fetch user profile or organization");
  }

  const organizationId = profile.organization_id;

  // 👷‍♂️ Fetch workers & stations
  const { data: workersData, error: workerError } = await supabase
    .from('workers')
    .select('*')
    .eq('organization_id', organizationId);

  // Modified to include hours column in the query
  const { data: stationsData, error: stationError } = await supabase
    .from('stations')
    .select('*, hours')
    .eq('organization_id', organizationId);

  if (workerError || stationError) {
    console.error('Error fetching data:', workerError || stationError);
    return [];
  }

  // 📅 Determine current and previous week's week_ending date
  const { data: scheduleData, error: scheduleError } = await supabase
    .from('stations')
    .select('date')
    .eq('organization_id', organizationId)
    .order('date', { ascending: true })
    .limit(1);

  if (scheduleError || !scheduleData.length) {
    console.error('Error fetching earliest date or no stations found:', scheduleError);
    return [];
  }

  const earliestDate = new Date(scheduleData[0].date);
  const currentWeekStart = new Date(earliestDate); // Sunday of current week
  const prevWeekEnding = new Date(currentWeekStart);
  prevWeekEnding.setDate(currentWeekStart.getDate() - 1); // Saturday of previous week
  // 📋 Fetch previous week's Saturday shifts
  const { data: prevWeekShifts, error: prevShiftError } = await supabase
    .from('schedule_entries')
    .select('worker_name, time')
    .eq('organization_id', organizationId)
    .eq('week_ending', prevWeekEnding.toISOString().split('T')[0])
    .eq('day_of_week', 'Saturday');


  if (prevShiftError) {
    console.error('Error fetching previous week shifts:', prevShiftError);
    return [];
  }

  // 📊 Setup tracking
  const workerAllocations = {};
  const workerShiftHistory = {};
  const workerTotalHours = {};

  // 🧠 Preprocess workers
  const workers = workersData.map(worker => ({
    ...worker,
    canworkstations: worker.canworkstations || [],
    availabilityByDay: {
      monday: worker.monday?.toLowerCase() || null,
      tuesday: worker.tuesday?.toLowerCase() || null,
      wednesday: worker.wednesday?.toLowerCase() || null,
      thursday: worker.thursday?.toLowerCase() || null,
      friday: worker.friday?.toLowerCase() || null,
      saturday: worker.saturday?.toLowerCase() || null,
      sunday: worker.sunday?.toLowerCase() || null,
    },
    availableDaysCount: getAvailableDaysCount({
      monday: worker.monday?.toLowerCase() || null,
      tuesday: worker.tuesday?.toLowerCase() || null,
      wednesday: worker.wednesday?.toLowerCase() || null,
      thursday: worker.thursday?.toLowerCase() || null,
      friday: worker.friday?.toLowerCase() || null,
      saturday: worker.saturday?.toLowerCase() || null,
      sunday: worker.sunday?.toLowerCase() || null,
    }),
    hasWeekend: hasWeekendAvailability({
      monday: worker.monday?.toLowerCase() || null,
      tuesday: worker.tuesday?.toLowerCase() || null,
      wednesday: worker.wednesday?.toLowerCase() || null,
      thursday: worker.thursday?.toLowerCase() || null,
      friday: worker.friday?.toLowerCase() || null,
      saturday: worker.saturday?.toLowerCase() || null,
      sunday: worker.sunday?.toLowerCase() || null,
    }),
  }));

  // First Pass: Assign only specified workers to stations
  const firstPassResults = stationsData.map((station) => {
    const shiftType = getShiftType(station.time).toLowerCase();
    const shiftDurationHours = Number(station.hours) || getShiftDurationInHours(station.time);
    const currentStartInMinutes = getShiftStartInMinutes(station.time);
    const currentEndInMinutes = getShiftEndInMinutes(station.time);
    const day = station.day.toLowerCase();
    const stationName = station.location.toLowerCase();

    // Get allowed workers for this station
    const allowedWorkerNames = stationWorkerMapping[station.location] || [];

    // Filter eligible workers from the allowed list
    const eligibleWorkers = workers.filter((worker) => {
      if (!allowedWorkerNames.includes(worker.name)) return false;

      const shiftPreference = worker.availabilityByDay[day];
      const isAvailable = shiftPreference === 'any' || shiftPreference === shiftType;

      const canWorkAtLocation = worker.canworkstations
        .map(loc => loc.toLowerCase())
        .includes(stationName);

      const isNotAllocatedForDay = !workerAllocations[worker.id]?.includes(day);

      let hasEnoughRest = true;
      const todayIndex = daysOfWeek.indexOf(day);
      const prevDay = todayIndex > 0 ? daysOfWeek[todayIndex - 1] : null;
      const nextDay = todayIndex < daysOfWeek.length - 1 ? daysOfWeek[todayIndex + 1] : null;


      // Check rest period from previous day's shift
      if (prevDay && workerShiftHistory[worker.id]?.[prevDay]) {
        const prevTime = workerShiftHistory[worker.id][prevDay].time;
        const prevStart = getShiftStartInMinutes(prevTime);
        const prevEnd = getShiftEndInMinutes(prevTime);
        const isPrevOvernight = prevEnd <= prevStart;
        let restMinutes;
        if (!isPrevOvernight) {
          // Non-overnight: (prev end to midnight) + (midnight to current start)
          restMinutes = (1440 - prevEnd) + currentStartInMinutes;
        } else {
          // Overnight: current start - prev end (both from midnight)
          restMinutes = currentStartInMinutes - prevEnd;
        }
        hasEnoughRest = restMinutes >= 720;
      }
      // For Sunday, check previous week's Saturday shift
      if (day === 'sunday') {
        const prevSaturdayShift = prevWeekShifts.find(shift => shift.worker_name === worker.name);
        if (prevSaturdayShift && prevSaturdayShift.time) {
          const prevStart = getShiftStartInMinutes(prevSaturdayShift.time);
          const prevEnd = getShiftEndInMinutes(prevSaturdayShift.time);
          const isPrevOvernight = prevEnd <= prevStart;
          let restMinutes;
          if (!isPrevOvernight) {
            // Non-overnight: (prev end to midnight) + (midnight to current start)
            restMinutes = (1440 - prevEnd) + currentStartInMinutes;
          } else {
            // Overnight: current start - prev end (both from midnight)
            restMinutes = currentStartInMinutes - prevEnd;
          }
          hasEnoughRest = restMinutes >= 720;
        }
      }
      // Check rest period to next day's shift
      if (hasEnoughRest && nextDay && workerShiftHistory[worker.id]?.[nextDay]) {
        const nextTime = workerShiftHistory[worker.id][nextDay].time;
        const nextStart = getShiftStartInMinutes(nextTime);
        const isCurrentOvernight = currentEndInMinutes <= currentStartInMinutes;
        let restMinutes;
        if (!isCurrentOvernight) {
          // Non-overnight: (current end to midnight) + (midnight to next start)
          restMinutes = (1440 - currentEndInMinutes) + nextStart;
        } else {
          // Overnight: next start - current end (both from midnight)
          restMinutes = nextStart - currentEndInMinutes;
        }
        hasEnoughRest = restMinutes >= 720;
      }

      const currentHours = workerTotalHours[worker.id] || 0;
      const exceedsLimit = currentHours + shiftDurationHours > 72;

      const shiftCount = workerAllocations[worker.id]?.length || 0;
      const withinShiftLimit = shiftCount < 5;

      return isAvailable && canWorkAtLocation && isNotAllocatedForDay && hasEnoughRest && !exceedsLimit && withinShiftLimit;
    });

    // Prioritize supervisor (first in allowedWorkerNames, assuming it's the supervisor)
    eligibleWorkers.sort((a, b) => {
      const indexA = allowedWorkerNames.indexOf(a.name);
      const indexB = allowedWorkerNames.indexOf(b.name);
      return indexA - indexB; // Lower index (supervisor) comes first
    });

    const bestWorker = eligibleWorkers[0];

    if (bestWorker) {
      if (!workerAllocations[bestWorker.id]) workerAllocations[bestWorker.id] = [];
      if (!workerShiftHistory[bestWorker.id]) workerShiftHistory[bestWorker.id] = {};
      if (!workerTotalHours[bestWorker.id]) workerTotalHours[bestWorker.id] = 0;

      workerAllocations[bestWorker.id].push(day);
      workerShiftHistory[bestWorker.id][day] = { shiftType, time: station.time };
      workerTotalHours[bestWorker.id] += shiftDurationHours;

      return {
        ...station,
        allocatedTo: bestWorker.name,
      };
    } else {
      return {
        ...station,
        allocatedTo: 'Unassigned',
      };
    }
  });

  // Second Pass: Process unassigned stations with original logic
  const finalResults = firstPassResults.map((station) => {
    if (station.allocatedTo !== 'Unassigned') {
      return station; // Skip already assigned stations
    }

    const shiftType = getShiftType(station.time).toLowerCase();
    const shiftDurationHours = Number(station.hours) || getShiftDurationInHours(station.time);
    const currentStartInMinutes = getShiftStartInMinutes(station.time);
    const currentEndInMinutes = getShiftEndInMinutes(station.time);
    const day = station.day.toLowerCase();

    // Filter eligible workers (using original logic)
    const eligibleWorkers = workers.filter((worker) => {
      const shiftPreference = worker.availabilityByDay[day];
      const isAvailable = shiftPreference === 'any' || shiftPreference === shiftType;

      const canWorkAtLocation = worker.canworkstations
        .map(loc => loc.toLowerCase())
        .includes(station.location.toLowerCase());

      const isNotAllocatedForDay = !workerAllocations[worker.id]?.includes(day);

      let hasEnoughRest = true;
      const todayIndex = daysOfWeek.indexOf(day);
      const prevDay = todayIndex > 0 ? daysOfWeek[todayIndex - 1] : null;
      const nextDay = todayIndex < daysOfWeek.length - 1 ? daysOfWeek[todayIndex + 1] : null;

      // Check rest period from previous day's shift
      if (prevDay && workerShiftHistory[worker.id]?.[prevDay]) {
        const prevTime = workerShiftHistory[worker.id][prevDay].time;
        const prevStart = getShiftStartInMinutes(prevTime);
        const prevEnd = getShiftEndInMinutes(prevTime);
        const isPrevOvernight = prevEnd <= prevStart;
        let restMinutes;
        if (!isPrevOvernight) {
          // Non-overnight: (prev end to midnight) + (midnight to current start)
          restMinutes = (1440 - prevEnd) + currentStartInMinutes;
        } else {
          // Overnight: current start - prev end (both from midnight)
          restMinutes = currentStartInMinutes - prevEnd;
        }
        hasEnoughRest = restMinutes >= 720;
      }
      // For Sunday, check previous week's Saturday shift
      if (day === 'sunday') {
        const prevSaturdayShift = prevWeekShifts.find(shift => shift.worker_name === worker.name);
        if (prevSaturdayShift && prevSaturdayShift.time) {
          const prevStart = getShiftStartInMinutes(prevSaturdayShift.time);
          const prevEnd = getShiftEndInMinutes(prevSaturdayShift.time);
          const isPrevOvernight = prevEnd <= prevStart;
          let restMinutes;
          if (!isPrevOvernight) {
            // Non-overnight: (prev end to midnight) + (midnight to current start)
            restMinutes = (1440 - prevEnd) + currentStartInMinutes;
          } else {
            // Overnight: current start - prev end (both from midnight)
            restMinutes = currentStartInMinutes - prevEnd;
          }
          hasEnoughRest = restMinutes >= 720;
        }
      }
      // Check rest period to next day's shift
      if (hasEnoughRest && nextDay && workerShiftHistory[worker.id]?.[nextDay]) {
        const nextTime = workerShiftHistory[worker.id][nextDay].time;
        const nextStart = getShiftStartInMinutes(nextTime);
        const isCurrentOvernight = currentEndInMinutes <= currentStartInMinutes;
        let restMinutes;
        if (!isCurrentOvernight) {
          // Non-overnight: (current end to midnight) + (midnight to next start)
          restMinutes = (1440 - currentEndInMinutes) + nextStart;
        } else {
          // Overnight: next start - current end (both from midnight)
          restMinutes = nextStart - currentEndInMinutes;
        }
        hasEnoughRest = restMinutes >= 720;
      }

      const currentHours = workerTotalHours[worker.id] || 0;
      const exceedsLimit = currentHours + shiftDurationHours > 72;

      const shiftCount = workerAllocations[worker.id]?.length || 0;
      const withinShiftLimit = shiftCount < 5;

      return isAvailable && canWorkAtLocation && isNotAllocatedForDay && hasEnoughRest && !exceedsLimit && withinShiftLimit;
    });

    // Sort by total hours worked and availability
    eligibleWorkers.sort((a, b) => {
      const availableDaysA = a.availableDaysCount;
      const availableDaysB = b.availableDaysCount;
      if (availableDaysA !== availableDaysB) {
        return availableDaysB - availableDaysA; // Higher availability first
      }
      const hasWeekendA = a.hasWeekend;
      const hasWeekendB = b.hasWeekend;
      if (hasWeekendA !== hasWeekendB) {
        return hasWeekendB - hasWeekendA; // Prefer workers with weekend availability
      }
      const hoursA = workerTotalHours[a.id] || 0;
      const hoursB = workerTotalHours[b.id] || 0;
      return hoursA - hoursB; // Lower hours worked first if availability is equal
    });

    const bestWorker = eligibleWorkers[0];

    if (bestWorker) {
      if (!workerAllocations[bestWorker.id]) workerAllocations[bestWorker.id] = [];
      if (!workerShiftHistory[bestWorker.id]) workerShiftHistory[bestWorker.id] = {};
      if (!workerTotalHours[bestWorker.id]) workerTotalHours[bestWorker.id] = 0;

      workerAllocations[bestWorker.id].push(day);
      workerShiftHistory[bestWorker.id][day] = { shiftType, time: station.time };
      workerTotalHours[bestWorker.id] += shiftDurationHours;

      return {
        ...station,
        allocatedTo: bestWorker.name,
      };
    } else {
      return {
        ...station,
        allocatedTo: 'Unassigned',
      };
    }
  });

  return finalResults;
};

export default allocateWorkers;