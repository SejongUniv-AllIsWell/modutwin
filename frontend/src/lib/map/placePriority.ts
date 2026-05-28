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

export interface CanonicalPlace {
  canonicalName: string;
  aliases: string[];
}

const canonicalPlaceByAlias = (() => {
  const map = new Map<string, CanonicalPlace>();
  for (const entry of sejongUniversityPlacePriority.addressPriority) {
    const allNames = [entry.name, ...(entry.aliases ?? [])]
      .map((name) => name.trim())
      .filter(Boolean);
    const info: CanonicalPlace = {
      canonicalName: entry.name,
      aliases: Array.from(new Set(allNames)),
    };
    for (const name of allNames) {
      const normalized = normalizePriorityText(name);
      if (normalized.length > 0) map.set(normalized, info);
    }
  }
  return map;
})();

const matchesPriorityList = (placeName: string) => (
  canonicalPlaceByAlias.has(normalizePriorityText(placeName))
);

export const resolveCanonicalPlace = (placeName: string): CanonicalPlace | null => {
  const normalized = normalizePriorityText(placeName.trim());
  if (!normalized) return null;
  return canonicalPlaceByAlias.get(normalized) ?? null;
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
