import type { UploaderFixedContext } from '@/components/upload/MultipartUploader';

// useSearchParams() 가 돌려주는 ReadonlyURLSearchParams 와 표준 URLSearchParams 를 모두 받는 구조적 타입.
interface SearchParamsLike {
  get(key: string): string | null;
}

/**
 * /register 계열 페이지가 쿼리스트링에서 등록 컨텍스트를 복원한다.
 *
 * basemap 은 module_name 이 빈 문자열이므로 필수 조건에서 제외한다.
 * (building 상세 / floor 상세의 등록 버튼이 넘겨준 qs 와 동일한 키를 사용.)
 */
export function parseRegisterContext(sp: SearchParamsLike): UploaderFixedContext | null {
  const purpose = sp.get('purpose') ?? '';
  const buildingName = sp.get('building_name') ?? '';
  const floorNumberRaw = sp.get('floor_number');
  const floorNumber = floorNumberRaw === null ? NaN : Number(floorNumberRaw);

  if (!purpose || !buildingName || !Number.isFinite(floorNumber)) return null;

  return {
    purpose,
    building_id: sp.get('building_id') ?? '',
    building_name: buildingName,
    floor_id: sp.get('floor_id') ?? '',
    floor_number: floorNumber,
    module_name: sp.get('module_name') ?? '',
    place_id: sp.get('place_id') ?? '',
    address_name: sp.get('address_name') ?? '',
    road_address_name: sp.get('road_address_name') ?? '',
    lat: sp.get('lat') ?? '',
    lng: sp.get('lng') ?? '',
  };
}
