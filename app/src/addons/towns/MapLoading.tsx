import { Skeleton, SkeletonRows } from "../../components/ui";

export function MapLoading() {
  return (
    <div className="towns map-loading" role="status" aria-label="loading map">
      <div className="towns-map">
        <Skeleton className="map-skeleton" />
      </div>
      <div className="towns-list">
        <SkeletonRows count={5} label="loading collection" />
      </div>
    </div>
  );
}
