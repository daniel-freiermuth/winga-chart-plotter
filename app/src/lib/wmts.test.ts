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
  /** Raw XML appended inside <Layer> after the standard children (e.g. <Style>, <Dimension>). */
  extra?: string;
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
    ${opts.extra ?? ''}
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

  it('tier 3: throws when no layer links a compatible TMS', () => {
    // Neither layer links a WebMercator TMS, so no layer can be served on a
    // grid MapLibre can render — there is nothing valid to fall back to.
    const doc = xml(capabilities({
      tileMatrixSets: TILE_MATRIX_SETS,
      layers: [
        layer({ id: 'first',  tmsLinks: [] }),
        layer({ id: 'second', tmsLinks: ['WGS84'] }),
      ].join(''),
    }));
    expect(() => parseDoc(doc, 'https://example.com'))
      .toThrow('No layer links an EPSG:3857 / WebMercatorQuad tile matrix set');
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

  it('throws when the preferred layer links no compatible TMS', () => {
    // The preferred layer is only served in WGS84. Substituting the document's
    // WebMercator TMS would request tiles on a grid this layer never declares.
    const doc = xml(capabilities({
      tileMatrixSets: [
        tms('WebMercator', 'EPSG:3857'),
        tms('WGS84', 'EPSG:4326'),
      ].join(''),
      layers: [
        layer({ id: 'wgs-only', tmsLinks: ['WGS84'] }),
        layer({ id: 'mercator', tmsLinks: ['WebMercator'] }),
      ].join(''),
    }));
    expect(() => parseDoc(doc, 'https://example.com', 'wgs-only'))
      .toThrow('Layer "wgs-only" links no EPSG:3857 / WebMercatorQuad tile matrix set');
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

  it('REST: ResourceURL without a template attribute falls through to KVP', () => {
    // A ResourceURL lacking `template` is not a usable REST endpoint; it must
    // not yield an empty tile URL that callers would record as a success.
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
    const kvp =
      'https://example.com?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile' +
      '&LAYER=notemplate&TILEMATRIXSET=WebMercator' +
      '&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image%2Fpng';
    expect(info.tileUrlTemplate).toBe(kvp);
    expect(info.availableLayers[0]?.tileUrl).toBe(kvp);
  });

  it('REST: ResourceURL with an empty template attribute falls through to KVP', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({ id: 'blank', tmsLinks: ['WebMercator'], resourceUrl: '' }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.tileUrlTemplate).toContain('REQUEST=GetTile');
    expect(info.tileUrlTemplate).toContain('LAYER=blank');
    expect(info.availableLayers[0]?.tileUrl).toBe(info.tileUrlTemplate);
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

  it('REST: {Style} is replaced with the layer default style identifier', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({
        id: 'sea',
        tmsLinks: ['WebMercator'],
        resourceUrl: 'https://t/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png',
        extra:
          '<Style><Identifier>night</Identifier></Style>' +
          '<Style isDefault="true"><Identifier>default</Identifier></Style>',
      }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.tileUrlTemplate).toBe('https://t/default/WebMercator/{z}/{y}/{x}.png');
    expect(info.availableLayers[0]!.tileUrl).toBe(info.tileUrlTemplate);
  });

  it('REST: template variables match case-insensitively (GeoServer {style})', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({
        id: 'dwd:WORLDMAP',
        tmsLinks: ['WebMercator'],
        resourceUrl: 'https://gs/rest/dwd:WORLDMAP/{style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}?format=image/png',
        extra: '<Style isDefault="true"><Identifier>default</Identifier></Style>',
      }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.tileUrlTemplate).toBe(
      'https://gs/rest/dwd:WORLDMAP/default/WebMercator/{z}/{y}/{x}?format=image/png',
    );
  });

  it('REST: dimension placeholders are replaced with the dimension default (GIBS {Time})', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({
        id: 'MODIS',
        tmsLinks: ['WebMercator'],
        resourceUrl: 'https://gibs/MODIS/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpeg',
        extra:
          '<Style isDefault="true"><Identifier>default</Identifier></Style>' +
          '<Dimension><Identifier>Time</Identifier><Default>default</Default><Value>2024-01-01</Value></Dimension>',
      }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.tileUrlTemplate).toBe('https://gibs/MODIS/default/default/WebMercator/{z}/{y}/{x}.jpeg');
    expect(info.availableLayers[0]!.tileUrl).toBe(info.tileUrlTemplate);
  });

  it('REST: skips a tile template with a variable the layer cannot fill (GIBS {Time} without <Dimension>)', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({
        id: 'VIIRS',
        tmsLinks: ['WebMercator'],
        resourceUrl: 'https://gibs/VIIRS/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png',
        extra:
          '<ResourceURL resourceType="tile" template="https://gibs/VIIRS/default/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png" />',
      }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.tileUrlTemplate).toBe('https://gibs/VIIRS/default/WebMercator/{z}/{y}/{x}.png');
    expect(info.availableLayers[0]!.tileUrl).toBe(info.tileUrlTemplate);
  });

  it('KVP: GetTile carries the mandatory STYLE parameter from the default style', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({
        id: 'ocean',
        tmsLinks: ['WebMercator'],
        extra: '<Style isDefault="true"><Identifier>default</Identifier></Style>',
      }),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.tileUrlTemplate).toContain('&STYLE=default&');
    expect(info.availableLayers[0]!.tileUrl).toBe(info.tileUrlTemplate);
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

  it('drops GetCapabilities SERVICE/REQUEST/VERSION params from a pasted capabilities URL', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({ id: 'L', tmsLinks: ['WebMercator'] }),
    }));
    const info = parseDoc(
      doc,
      'https://example.com/wmts?service=WMTS&token=abc&REQUEST=GetCapabilities&Version=1.0.0',
    );
    const expected =
      'https://example.com/wmts?token=abc&SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile' +
      '&LAYER=L&TILEMATRIXSET=WebMercator&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}&FORMAT=image%2Fpng';
    expect(info.tileUrlTemplate).toBe(expected);
    expect(info.availableLayers[0]?.tileUrl).toBe(expected);
  });

  it('uses ? when the pasted capabilities URL has no other params', () => {
    const doc = xml(capabilities({
      tileMatrixSets: TMS,
      layers: layer({ id: 'L', tmsLinks: ['WebMercator'] }),
    }));
    const info = parseDoc(doc, 'https://example.com/wmts?SERVICE=WMTS&REQUEST=GetCapabilities');
    expect(info.tileUrlTemplate).toMatch(/^https:\/\/example\.com\/wmts\?SERVICE=WMTS&VERSION=1\.0\.0&REQUEST=GetTile&/);
    expect(info.tileUrlTemplate).not.toContain('GetCapabilities');
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

  it('gives layers without a compatible TMS link no usable tileUrl', () => {
    // '' is the "no usable URL" value pickWmtsTileUrl and the picker already
    // skip; a URL on the document's WebMercator TMS would be the wrong grid.
    const doc = xml(capabilities({
      tileMatrixSets: [
        tms('WebMercator', 'EPSG:3857'),
        tms('WGS84', 'EPSG:4326'),
      ].join(''),
      layers: [
        layer({ id: 'mercator', tmsLinks: ['WebMercator'] }),
        layer({
          id: 'wgs-rest',
          tmsLinks: ['WGS84'],
          resourceUrl: 'https://tiles.example/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png',
        }),
        layer({ id: 'wgs-kvp', tmsLinks: ['WGS84'] }),
      ].join(''),
    }));
    const info = parseDoc(doc, 'https://example.com');
    expect(info.availableLayers.map(l => [l.id, l.tileUrl !== ''])).toEqual([
      ['mercator', true],
      ['wgs-rest', false],
      ['wgs-kvp',  false],
    ]);
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

// ---------------------------------------------------------------------------
// TileMatrix identifiers (WMTS TILEMATRIX is an identifier, not a zoom int)
// ---------------------------------------------------------------------------

/** A TileMatrixSet element with explicit <TileMatrix> children. */
function tmsWithMatrices(id: string, crs: string, matrixIds: string[]): string {
  const matrices = matrixIds
    .map(m => `<TileMatrix><Identifier>${m}</Identifier></TileMatrix>`)
    .join('');
  return `<TileMatrixSet><Identifier>${id}</Identifier><SupportedCRS>${crs}</SupportedCRS>${matrices}</TileMatrixSet>`;
}

describe('TileMatrix identifier mapping', () => {
  // GeoWebCache (bundled with GeoServer) names its matrices 'EPSG:900913:N'.
  const GWC = tmsWithMatrices('EPSG:900913', 'urn:ogc:def:crs:EPSG::900913',
    ['EPSG:900913:0', 'EPSG:900913:1', 'EPSG:900913:2']);

  it('KVP: TILEMATRIX uses the prefixed matrix identifier', () => {
    const doc = xml(capabilities({
      tileMatrixSets: GWC,
      layers: layer({ id: 'dwd:Warngebiete', tmsLinks: ['EPSG:900913'] }),
    }));
    const info = parseDoc(doc, 'https://maps.example/gwc/service/wmts');
    expect(info.tileUrlTemplate).toContain('&TILEMATRIX=EPSG%3A900913%3A{z}&');
    expect(info.availableLayers[0]!.tileUrl).toContain('&TILEMATRIX=EPSG%3A900913%3A{z}&');
  });

  it('REST: {TileMatrix} expands to the prefixed matrix identifier', () => {
    const doc = xml(capabilities({
      tileMatrixSets: GWC,
      layers: layer({
        id: 'dwd:WORLDMAP',
        tmsLinks: ['EPSG:900913'],
        resourceUrl: 'https://maps.example/rest/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}',
      }),
    }));
    const info = parseDoc(doc, 'https://maps.example');
    const expected = 'https://maps.example/rest/EPSG:900913/EPSG:900913:{z}/{y}/{x}';
    expect(info.tileUrlTemplate).toBe(expected);
    expect(info.availableLayers[0]!.tileUrl).toBe(expected);
  });

  it('plain integer matrix identifiers map directly to {z}', () => {
    const doc = xml(capabilities({
      tileMatrixSets: tmsWithMatrices('WebMercatorQuad', 'EPSG:3857', ['0', '1', '2']),
      layers: layer({ id: 'L', tmsLinks: ['WebMercatorQuad'] }),
    }));
    expect(parseDoc(doc, 'https://x.com').tileUrlTemplate).toContain('&TILEMATRIX={z}&');
  });

  it('rejects sets whose matrix identifiers are not a zoom sequence from 0', () => {
    const doc = xml(capabilities({
      tileMatrixSets: tmsWithMatrices('custom', 'EPSG:3857', ['a', 'b', 'c']),
      layers: layer({ id: 'L', tmsLinks: ['custom'] }),
    }));
    expect(() => parseDoc(doc, 'https://x.com')).toThrow(/No EPSG:3857/);
  });

  it('rejects sets whose matrix identifiers do not start at zoom 0', () => {
    const doc = xml(capabilities({
      tileMatrixSets: tmsWithMatrices('custom', 'EPSG:3857', ['1', '2', '3']),
      layers: layer({ id: 'L', tmsLinks: ['custom'] }),
    }));
    expect(() => parseDoc(doc, 'https://x.com')).toThrow(/No EPSG:3857/);
  });
});
