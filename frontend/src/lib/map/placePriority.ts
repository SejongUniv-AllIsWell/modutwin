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
  addressSearchRadiusMeters: number;
  coordinateOverrides?: PriorityCoordinateOverride[];
  addressPriority: PriorityPlaceEntry[];
}

export interface PriorityPlaceScore {
  isInPriorityList: boolean;
  isCampusPlace: boolean;
  isCampusOnlyName: boolean;
}

export interface PriorityPlaceCandidate extends PriorityPlaceScore {
  responseIndex: number;
  distance: number;
}

export const sejongUniversityPlacePriority = priorityList.sejongUniversity as PriorityPlaceConfig;

const normalizePriorityText = (value: string) => (
  value
    .replace(/[\s()[\]{}（）]/g, '')
    .toLowerCase()
);

const priorityNameTokens = sejongUniversityPlacePriority.addressPriority
  .flatMap((entry) => [entry.name, ...(entry.aliases ?? [])])
  .map(normalizePriorityText)
  .filter((name) => name.length > 0);

const matchesPriorityList = (placeName: string) => {
  const normalizedPlaceName = normalizePriorityText(placeName);
  return priorityNameTokens.some((name) => normalizedPlaceName === name);
};

export const scorePriorityPlaceName = (placeName: string): PriorityPlaceScore => {
  const trimmedPlaceName = placeName.trim();
  return {
    isInPriorityList: matchesPriorityList(trimmedPlaceName),
    isCampusPlace: trimmedPlaceName.includes(sejongUniversityPlacePriority.campusKeyword),
    isCampusOnlyName: trimmedPlaceName === sejongUniversityPlacePriority.campusKeyword,
  };
};

export const comparePriorityPlaceCandidates = <T extends PriorityPlaceCandidate>(a: T, b: T) => (
  Number(b.isInPriorityList) - Number(a.isInPriorityList)
  || a.responseIndex - b.responseIndex
  || Number(b.isCampusPlace) - Number(a.isCampusPlace)
  || Number(a.isCampusOnlyName) - Number(b.isCampusOnlyName)
  || a.distance - b.distance
);
