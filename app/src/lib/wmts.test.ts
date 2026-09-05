// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseDoc } from './wmts';

/** Parse an XML string into a Document via jsdom's DOMParser. */
function xml(s: string): Document {
  return new DOMParser().parseFromString(s, 'text/xml');
}

/**
 * Minimal valid WMTS Capabilities skeleton.
 * Callers inject <TileMatrixSet> and <Layer> blocks via parameters.
 */
function capabilities(opts: {
  tileMatrixSets?: string;
  layers?: string;
}): string {
  return `<?xml version="1.0"?>
<Capabilities>
  <Contents>
    ${opts.tileMatrixSets ?? ''}
    ${opts.layers ?? ''}
  </Contents>
</Capabilities>`;
}

/** A TileMatrixSet element with the given id and CRS. */
function tms(id: string, crs: string): string {
  return `<TileMatrixSet><Identifier>${id}</Identifier><SupportedCRS>${crs}</SupportedCRS></TileMatrixSet>`;
}

/** A Layer element. */
function layer(opts: {
  id: string;
  title?: string;
  format?: string;
  tmsLinks?: string[];
  resourceUrl?: string | null;
}): string {
  const links = (opts.tmsLinks ?? [])
    .map(t => `<TileMatrixSetLink><TileMatrixSet>${t}</TileMatrixSet></TileMatrixSetLink>`)
    .join('');
  const fmt = opts.format ? `<Format>${opts.format}</Format>` : '<Format>image/png</Format>';
  const res = opts.resourceUrl != null
    ? `<ResourceURL resourceType="tile" template="${opts.resourceUrl}" />`
    : '';
  return `<Layer>
    <Identifier>${opts.id}</Identifier>
    <Title>${opts.title ?? opts.id}</Title>
    ${fmt}
    ${links}
    ${res}
  </Layer>`;
}

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('parseDoc error paths', () => {
  it('throws when no compatible TMS exists', () => {
    const doc = xml(capabilities({
      tileMatrixSets: tms('SomeTMS', 'EPSG:4326'),
      layers: layer({ id: 'layer1', tmsLinks: ['SomeTMS'] }),
    }));
    expect(() => parseDoc(doc, 'https://example.com'))
      .toThrow('No EPSG:3857 / WebMercatorQuad tile matrix sets');
  });

  it('throws when there are zero Layer elements', () => {
    const doc = xml(capabilities({
      tileMatrixSets: tms('WebMercatorQuad', 'EPSG:3857'),
      // no layers
    }));
    expect(() => parseDoc(doc, 'https://example.com'))
      .toThrow('No layers in capabilities document');
  });
});

// ---------------------------------------------------------------------------
// pickLayer fallback tiers
// ---------------------------------------------------------------------------

describe('pickLayer fallback tiers', () => {
  const TILE_MATRIX_SETS = [
    tms('WebMercator', 'EPSG:3857'),
    tms('WGS84', 'EPSG:4326'),
  ].join('');

  it('tier 1: returns preferred layer by Identifier', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TILE_MATRIX_SETS,
      layers: [
        layer({ id: 'alpha', tmsLinks: ['WebMercator'] }),
        layer({ id: 'beta',  tmsLinks: ['WebMercator'] }),
      ].join(''),
    }));
    const info = parseDoc(doc, 'https://example.com', 'beta');
    expect(info.layerName).toBe('beta');
  });

  it('tier 2: first layer linking a compatible TMS when preferLayer misses', () => {
    // layer1 links only WGS84 (incompatible), layer2 links WebMercator
    const doc = xml(capabilities({
      tileMatrixSets: TILE_MATRIX_SETS,
      layers: [
        layer({ id: 'wgs-only', tmsLinks: ['WGS84'] }),
        layer({ id: 'mercator', tmsLinks: ['WebMercator'] }),
      ].join(''),
    }));
    const info = parseDoc(doc, 'https://example.com', 'nonexistent');
    expect(info.layerName).toBe('mercator');
  });

  it('tier 3: falls back to layers[0] when no layer links a compatible TMS', () => {
    // Both layers lack TileMatrixSetLink elements entirely
    const doc = xml(capabilities({
      tileMatrixSets: TILE_MATRIX_SETS,
      layers: [
        layer({ id: 'first',  tmsLinks: [] }),
        layer({ id: 'second', tmsLinks: [] }),
      ].join(''),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.layerName).toBe('first');
  });
});

// ---------------------------------------------------------------------------
// pickTileMatrixSet fallback
// ---------------------------------------------------------------------------

describe('pickTileMatrixSet fallback', () => {
  it('picks the layer-declared compatible TMS', () => {
    const doc = xml(capabilities({
      tileMatrixSets: [
        tms('WebMercator', 'EPSG:3857'),
        tms('GoogleMapsCompatible', 'EPSG:3857'),
      ].join(''),
      layers: layer({ id: 'L1', tmsLinks: ['GoogleMapsCompatible'] }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.tileMatrixSet).toBe('GoogleMapsCompatible');
  });

  it('falls back to an arbitrary compatible TMS when the layer has no matching link', () => {
    // Layer links only to WGS84 (not in compatible set), so pickTileMatrixSet
    // falls through and returns the first entry from the compatible set.
    const doc = xml(capabilities({
      tileMatrixSets: [
        tms('WebMercator', 'EPSG:3857'),
        tms('WGS84', 'EPSG:4326'),
      ].join(''),
      layers: layer({ id: 'L1', tmsLinks: ['WGS84'] }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    // Falls through to compatibleTms.values().next().value → 'WebMercator'
    expect(info.tileMatrixSet).toBe('WebMercator');
  });
});

// ---------------------------------------------------------------------------
// buildInfo: REST vs KVP
// ---------------------------------------------------------------------------

describe('buildInfo REST vs KVP', () => {
  const TMS = tms('WebMercator', 'EPSG:3857');

  it('REST: ResourceURL template is expanded to MapLibre {z}/{x}/{y}', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({
        id: 'sea',
        tmsLinks: ['WebMercator'],
        resourceUrl: 'https://tiles.example/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png',
      }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.tileUrlTemplate).toBe(
      'https://tiles.example/WebMercator/{z}/{y}/{x}.png',
    );
  });

  it('REST: missing template attribute yields empty tileUrlTemplate', () => {
    // Manually craft a ResourceURL element without a template attribute
    const raw = `<?xml version="1.0"?>
<Capabilities><Contents>
  ${TMS}
  <Layer>
    <Identifier>notemplate</Identifier>
    <Format>image/png</Format>
    <TileMatrixSetLink><TileMatrixSet>WebMercator</TileMatrixSet></TileMatrixSetLink>
    <ResourceURL resourceType="tile" />
  </Layer>
</Contents></Capabilities>`;
    const info = parseDoc(xml(raw), 'https://example.com');
    expect(info.tileUrlTemplate).toBe('');
  });

  it('KVP: builds a query-string URL when no ResourceURL exists', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({
        id: 'ocean',
        format: 'image/jpeg',
        tmsLinks: ['WebMercator'],
        // no resourceUrl → KVP branch
      }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.tileUrlTemplate).toContain('SERVICE=WMTS');
    expect(info.tileUrlTemplate).toContain('LAYER=ocean');
    expect(info.tileUrlTemplate).toContain('FORMAT=image%2Fjpeg');
    expect(info.tileUrlTemplate).toContain('{z}');
    expect(info.tileUrlTemplate).toContain('{y}');
    expect(info.tileUrlTemplate).toContain('{x}');
  });
});

// ---------------------------------------------------------------------------
// sep calculation (baseUrl with existing query string)
// ---------------------------------------------------------------------------

describe('baseUrl query-string separator', () => {
  const TMS = tms('WebMercator', 'EPSG:3857');

  it('uses ? when baseUrl has no query string', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({ id: 'L', tmsLinks: ['WebMercator'] }),
    }));
    const info = parseDoc(doc, 'https://example.com/wms');
    expect(info.tileUrlTemplate).toMatch(/^https:\/\/example\.com\/wms\?SERVICE=WMTS/);
  });

  it('uses & when baseUrl already contains a query string', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({ id: 'L', tmsLinks: ['WebMercator'] }),
    }));
    const info = parseDoc(doc, 'https://example.com/wms?token=abc');
    expect(info.tileUrlTemplate).toMatch(/^https:\/\/example\.com\/wms\?token=abc&SERVICE=WMTS/);
  });
});

// ---------------------------------------------------------------------------
// availableLayers
// ---------------------------------------------------------------------------

describe('availableLayers', () => {
  it('returns tileUrl for every layer (REST and KVP mixed)', () => {
    const doc = xml(capabilities({
      tileMatrixSets: tms('WebMercator', 'EPSG:3857'),
      layers: [
        layer({
          id: 'rest-layer',
          tmsLinks: ['WebMercator'],
          resourceUrl: 'https://tiles.example/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png',
        }),
        layer({
          id: 'kvp-layer',
          tmsLinks: ['WebMercator'],
        }),
      ].join(''),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.availableLayers).toHaveLength(2);
    expect(info.availableLayers[0]!.id).toBe('rest-layer');
    expect(info.availableLayers[0]!.tileUrl).toContain('{z}');
    expect(info.availableLayers[1]!.id).toBe('kvp-layer');
    expect(info.availableLayers[1]!.tileUrl).toContain('SERVICE=WMTS');
  });
});

// ---------------------------------------------------------------------------
// findCompatibleTileMatrixSets recognition
// ---------------------------------------------------------------------------

describe('compatible TMS recognition', () => {
  it('recognizes WebMercatorQuad by name', () => {
    const doc = xml(capabilities({
      tileMatrixSets: tms('WebMercatorQuad', 'urn:ogc:def:crs:OGC:2:84'),
      layers: layer({ id: 'L', tmsLinks: ['WebMercatorQuad'] }),
    }));
    expect(parseDoc(doc, 'https://x.com').tileMatrixSet).toBe('WebMercatorQuad');
  });

  it('recognizes GoogleMapsCompatible by name', () => {
    const doc = xml(capabilities({
      tileMatrixSets: tms('GoogleMapsCompatible', 'urn:ogc:def:crs:EPSG:6.18:3:3857'),
      layers: layer({ id: 'L', tmsLinks: ['GoogleMapsCompatible'] }),
    }));
    expect(parseDoc(doc, 'https://x.com').tileMatrixSet).toBe('GoogleMapsCompatible');
  });

  it('recognizes CRS containing 900913', () => {
    const doc = xml(capabilities({
      tileMatrixSets: tms('custom', 'EPSG:900913'),
      layers: layer({ id: 'L', tmsLinks: ['custom'] }),
    }));
    expect(parseDoc(doc, 'https://x.com').tileMatrixSet).toBe('custom');
  });
});
