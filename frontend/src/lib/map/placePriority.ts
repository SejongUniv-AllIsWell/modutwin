import priorityList from '@/config/priorityList.json';

interface PriorityCoordinate {
  lat: number;
  lng: number;
}

interface PriorityPlaceEntry {
  name: string;
  aliases?: string[];
}

export interface PriorityCoordinateOverride {
  name: string;
  aliases?: string[];
  lat: number;
  lng: number;
  radiusMeters: number;
  address_name?: string | null;
  road_address_name?: string | null;
}

interface PriorityPlaceConfig {
  campusKeyword: string;
  center: PriorityCoordinate;
  campusRadiusMeters: number;
  placeSearchRadiusMeters: number;
  addressSearchRadiusMeters: number;
  coordinateOverrides?: PriorityCoordinateOverride[];
  addressPriority: PriorityPlaceEntry[];
}

export interface PriorityPlaceScore {
  priorityIndex: number;
  isCampusPlace: boolean;
  isCampusOnlyName: boolean;
}

export interface PriorityPlaceCandidate extends PriorityPlaceScore {
  distance: number;
}

const PRIORITY_FALLBACK_INDEX = Number.MAX_SAFE_INTEGER;

export const sejongUniversityPlacePriority = priorityList.sejongUniversity as PriorityPlaceConfig;

const normalizePriorityText = (value: string) => (
  value
    .replace(/[\s()[\]{}（）]/g, '')
    .toLowerCase()
);

const priorityEntries = sejongUniversityPlacePriority.addressPriority.map((entry, index) => ({
  index,
  names: [entry.name, ...(entry.aliases ?? [])]
    .map(normalizePriorityText)
    .filter(Boolean),
}));

const priorityIndexForPlaceName = (placeName: string) => {
  const normalizedPlaceName = normalizePriorityText(placeName);
  const matched = priorityEntries.find(({ names }) => (
    names.some((name) => name.length > 0 && normalizedPlaceName.includes(name))
  ));
  return matched?.index ?? PRIORITY_FALLBACK_INDEX;
};

export const scorePriorityPlaceName = (placeName: string): PriorityPlaceScore => {
  const trimmedPlaceName = placeName.trim();
  return {
    priorityIndex: priorityIndexForPlaceName(trimmedPlaceName),
    isCampusPlace: trimmedPlaceName.includes(sejongUniversityPlacePriority.campusKeyword),
    isCampusOnlyName: trimmedPlaceName === sejongUniversityPlacePriority.campusKeyword,
  };
};

export const comparePriorityPlaceCandidates = <T extends PriorityPlaceCandidate>(a: T, b: T) => (
  a.priorityIndex - b.priorityIndex
  || Number(b.isCampusPlace) - Number(a.isCampusPlace)
  || Number(a.isCampusOnlyName) - Number(b.isCampusOnlyName)
  || a.distance - b.distance
);
