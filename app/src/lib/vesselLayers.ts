import type { Layer } from '@deck.gl/core';
import { PathLayer } from '@deck.gl/layers';
import { PathStyleExtension } from '@deck.gl/extensions';
import { VesselMorphLayer, MORPH_ARROW } from '../layers/VesselMorphLayer';
import type { AppearanceSettings, LineAppearance } from '../stores/settings.svelte';
import type { VesselState } from '../stores/vessel';
import type { ProjectionId } from '../stores/mapView.svelte';
import { rhumbCoords, gcCoords } from './lineGeometry';
import { hexToRgba, lineStyleDash } from './mapStyles';
import { processRouteCoords, splitRouteSegments } from './trackProcessing';

interface LatLon { longitude: number; latitude: number }
type RouteGeo = { geometry: { coordinates: number[][] } } | null | undefined;

/**
 * Builds the own-vessel deck.gl layers: heading/COG/GC predictor lines plus the vessel
 * icon. Pure function of its arguments — callers control what's tracked as an effect
 * dependency. The position effect tracks $vesselState (60 Hz orientation ticks); the
 * appearance effect must not, so it reads state/zoom/projection via untrack() and passes
 * them in here instead.
 */
export function buildOwnVesselLayers(
  ap: AppearanceSettings,
  state: VesselState,
  zoom: number,
  projection: ProjectionId,
): Layer[] {
  const layers: Layer[] = [];
  if (!state.position) return layers;
  const { longitude, latitude } = state.position;

  function lineDistM(line: LineAppearance, sogMs: number | null): number {
    if (line.lengthUnit === 'nm')  return line.lengthValue * 1852;
    if (line.lengthUnit === 'min') return sogMs !== null ? line.lengthValue * 60 * sogMs : 0;
    // px → meters per pixel at current zoom & latitude (WebMercator, 512px tile)
    const mpp = (Math.cos(latitude * Math.PI / 180) * 40075016.686) / (512 * Math.pow(2, zoom));
    return line.lengthValue * mpp;
  }

  if (state.cog !== null) {
    const cogDashProps = { getDashArray: lineStyleDash(ap.cog.style, ap.cog.width) };
    layers.push(new PathLayer<[number, number][]>({
      id: 'vessel-cog-line',
      data: [rhumbCoords(longitude, latitude, state.cog, lineDistM(ap.cog, state.sog))],
      getPath: d => d,
      getColor: hexToRgba(ap.cog.color, 255),
      getWidth: ap.cog.width,
      ...cogDashProps,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: false,
      extensions: [new PathStyleExtension({ dash: true })],
    }));

    const gcDashProps = { getDashArray: lineStyleDash(ap.gc.style, ap.gc.width) };
    layers.push(new PathLayer<[number, number][]>({
      id: 'vessel-gc-line',
      data: [gcCoords(longitude, latitude, state.cog, lineDistM(ap.gc, state.sog))],
      getPath: d => d,
      getColor: hexToRgba(ap.gc.color, 255),
      getWidth: ap.gc.width,
      ...gcDashProps,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: false,
      extensions: [new PathStyleExtension({ dash: true })],
    }));
  }

  if (state.heading !== null) {
    const hdgDashProps = { getDashArray: lineStyleDash(ap.heading.style, ap.heading.width) };
    const project = projection === 'globe' ? gcCoords : rhumbCoords;
    layers.push(new PathLayer<[number, number][]>({
      id: 'vessel-hdg-line',
      data: [project(longitude, latitude, state.heading, lineDistM(ap.heading, state.sog))],
      getPath: d => d,
      getColor: hexToRgba(ap.heading.color, 255),
      getWidth: ap.heading.width,
      ...hdgDashProps,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: false,
      extensions: [new PathStyleExtension({ dash: true })],
    }));
  }

  // Own vessel icon — rendered last (on top of its own predictor lines).
  // VesselMorphLayer handles globe mode, map-aligned rotation, and picking correctly.
  const orientRad      = state.heading ?? state.cog ?? null;
  const ownVesselColor = hexToRgba(ap.vesselColor, 255);
  const ownVesselSize  = ap.vesselSize / 64;
  layers.push(new VesselMorphLayer<number>({
    id: 'own-vessel-icon',
    data: [0],
    getPosition:    () => [longitude, latitude, 0],
    getSog:         () => 0,
    getCog:         () => 0,
    getHeading:     () => orientRad ?? 0,
    getRot:         () => 0,
    getAgeAtUpload: () => 0,
    getLength:      () => 0,
    getColor:       () => ownVesselColor,
    morphGeometry:  MORPH_ARROW,
    uploadTimestamp: 0,
    selfAnimate: false,
    settingsIconSize: ownVesselSize,
    pickable: true,
  }));

  return layers;
}

/**
 * Builds the active-route deck.gl layers: full planned polyline, active leg
 * (previousPoint → nextPoint), and bearing line (own vessel → nextPoint).
 * Rendered via deck.gl rather than MapLibre so they sit above AIS targets and the
 * own-vessel icon — the deck.gl overlay (interleaved: false) always draws on its
 * own canvas above MapLibre's, so a MapLibre line can never appear on top of them.
 */
export function buildCourseLayers(
  geo: RouteGeo,
  nxtPt: LatLon | null,
  prevPt: LatLon | null,
  ownPos: LatLon | null,
  ra: AppearanceSettings['route'],
): Layer[] {
  const layers: Layer[] = [];

  // Full planned route polyline from the REST resource — GC-densified, antimeridian-unwrapped,
  // and split bidirectionally so globe-circling routes render across all world copies.
  if (geo) {
    const processed = processRouteCoords(geo.geometry.coordinates as [number, number][]);
    const segments  = splitRouteSegments(processed);
    // getDashArray is a PathStyleExtension prop; spread from a variable to bypass the
    // excess-property check.
    const fullDashProps = { getDashArray: lineStyleDash(ra.remaining.style, ra.remaining.width) };
    layers.push(new PathLayer<[number, number][]>({
      id: 'route-full',
      data: segments,
      getPath: d => d,
      getColor: hexToRgba(ra.remaining.color, 255),
      getWidth: ra.remaining.width,
      ...fullDashProps,
      opacity: 0.65,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: true,
      extensions: [new PathStyleExtension({ dash: true })],
    }));
  }

  // Active leg: previousPoint → nextPoint (the current planned segment) — GC path.
  if (nxtPt && prevPt) {
    const path = processRouteCoords([[prevPt.longitude, prevPt.latitude], [nxtPt.longitude, nxtPt.latitude]]);
    const legDashProps = { getDashArray: lineStyleDash(ra.segment.style, ra.segment.width) };
    layers.push(new PathLayer<[number, number][]>({
      id: 'route-leg',
      data: [path],
      getPath: d => d,
      getColor: hexToRgba(ra.segment.color, 255),
      getWidth: ra.segment.width,
      ...legDashProps,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: true,
      extensions: [new PathStyleExtension({ dash: true })],
    }));
  }

  // Bearing line: own vessel → nextPoint (where I need to actually steer) — GC path.
  if (nxtPt && ownPos) {
    const path = processRouteCoords([[ownPos.longitude, ownPos.latitude], [nxtPt.longitude, nxtPt.latitude]]);
    const bearingDashProps = { getDashArray: lineStyleDash(ra.bearing.style, ra.bearing.width) };
    layers.push(new PathLayer<[number, number][]>({
      id: 'route-bearing',
      data: [path],
      getPath: d => d,
      getColor: hexToRgba(ra.bearing.color, 255),
      getWidth: ra.bearing.width,
      ...bearingDashProps,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: true,
      extensions: [new PathStyleExtension({ dash: true })],
    }));
  }

  return layers;
}
