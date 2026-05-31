export type ProjectionId = 'globe' | 'mercator';

function createMapViewStore() {
  let projection  = $state<ProjectionId>('mercator');
  let isFullscreen = $state(false);

  return {
    get projection()   { return projection; },
    set projection(v: ProjectionId) { projection = v; },
    get isFullscreen() { return isFullscreen; },
    set isFullscreen(v: boolean)    { isFullscreen = v; },
  };
}

export const mapView = createMapViewStore();
