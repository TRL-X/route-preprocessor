import { XMLParser } from 'fast-xml-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IMPORT_LIMITS, parseRouteFile } from '../../src/core/import';

const line = '<LineString><coordinates>0,0,0 1,1,1</coordinates></LineString>';
const nestedRoute = (depth: number, folder = '<Folder>'): string =>
  `<kml>${folder.repeat(depth - 3)}${line}${'</Folder>'.repeat(depth - 3)}</kml>`;
const depthError = `XML nesting exceeds ${IMPORT_LIMITS.maxXmlDepth} levels.`;

afterEach(() => vi.restoreAllMocks());

describe('XML nesting guard', () => {
  it.each([
    ['plain tags', '<Folder>'],
    ['double-quoted >', '<Folder note=">">'],
    ['single-quoted >', "<Folder note='>'>"],
    ['double-quoted />', '<Folder note="/>">'],
    ['single-quoted />', "<Folder note='/>'>"],
    ['mixed quotes', `<Folder note="'/>" other='"/>'>`],
  ])('enforces the exact depth boundary with %s', (_name, folder) => {
    const parsed = parseRouteFile(nestedRoute(IMPORT_LIMITS.maxXmlDepth, folder), 'limit.kml');
    expect(parsed.routes[0].points).toHaveLength(2);

    const parse = vi.spyOn(XMLParser.prototype, 'parse');
    expect(() =>
      parseRouteFile(nestedRoute(IMPORT_LIMITS.maxXmlDepth + 1, folder), 'deep.kml'),
    ).toThrow(depthError);
    expect(parse).not.toHaveBeenCalled();
  });

  it.each([
    ['comments', `<!-- ${'<Folder>'.repeat(70)} -->`],
    ['CDATA', `<![CDATA[${'<Folder>'.repeat(70)}]]>`],
    ['processing instructions', `<?note ${'<Folder>'.repeat(70)} ?>`],
  ])('ignores tag-like text in %s', (_name, data) => {
    const xml = nestedRoute(IMPORT_LIMITS.maxXmlDepth).replace('<kml>', `<kml>${data}`);
    expect(parseRouteFile(xml, 'limit.kml').routes[0].points).toHaveLength(2);
  });

  it.each([
    ['comments', `<!-- ${'</Folder>'.repeat(70)} -->`],
    ['CDATA', `<![CDATA[${'</Folder>'.repeat(70)}]]>`],
    ['processing instructions', `<?note ${'</Folder>'.repeat(70)} ?>`],
  ])('does not let closing-tag text in %s reduce depth', (_name, data) => {
    const xml = nestedRoute(IMPORT_LIMITS.maxXmlDepth + 1).replace('<kml>', `<kml>${data}`);
    const parse = vi.spyOn(XMLParser.prototype, 'parse');
    expect(() => parseRouteFile(xml, 'deep.kml')).toThrow(depthError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('does not let CDATA markers inside comments hide real elements', () => {
    const xml = nestedRoute(IMPORT_LIMITS.maxXmlDepth + 1)
      .replace('<kml>', '<kml><!-- <![CDATA[ -->')
      .replace('</kml>', '<!-- ]]> --></kml>');
    const parse = vi.spyOn(XMLParser.prototype, 'parse');
    expect(() => parseRouteFile(xml, 'deep.kml')).toThrow(depthError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('checks files without coordinates before building the XML object tree', () => {
    const count = IMPORT_LIMITS.maxXmlDepth;
    const xml = `<kml>${'<Folder note="/>">'.repeat(count)}${'</Folder>'.repeat(count)}</kml>`;
    const parse = vi.spyOn(XMLParser.prototype, 'parse');
    expect(() => parseRouteFile(xml, 'deep.kml')).toThrow(depthError);
    expect(parse).not.toHaveBeenCalled();
  });

  it('does not accumulate depth for self-closing siblings with quoted delimiters', () => {
    const emptyFolder = `<Folder note=">" other='/>' />`;
    const xml = nestedRoute(IMPORT_LIMITS.maxXmlDepth).replace(
      line,
      `${emptyFolder.repeat(70)}${line}`,
    );
    expect(parseRouteFile(xml, 'siblings.kml').routes[0].points).toHaveLength(2);
  });

  it.each(['<metadata/>', '<metadata />', '<metadata note=">" other="/>" />'])(
    'counts a self-closing leaf toward the depth limit: %s',
    (leaf) => {
      const xml = (depth: number) =>
        `<kml>${line}${'<Folder>'.repeat(depth - 2)}${leaf}${'</Folder>'.repeat(depth - 2)}</kml>`;
      expect(
        parseRouteFile(xml(IMPORT_LIMITS.maxXmlDepth), 'limit.kml').routes[0].points,
      ).toHaveLength(2);

      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      expect(() => parseRouteFile(xml(IMPORT_LIMITS.maxXmlDepth + 1), 'deep.kml')).toThrow(
        depthError,
      );
      expect(parse).not.toHaveBeenCalled();
    },
  );

  it('counts elements with non-ASCII names', () => {
    const xml = (depth: number) =>
      `<kml>${line}${'<层>'.repeat(depth - 1)}${'</层>'.repeat(depth - 1)}</kml>`;
    expect(
      parseRouteFile(xml(IMPORT_LIMITS.maxXmlDepth), 'limit.kml').routes[0].points,
    ).toHaveLength(2);

    const parse = vi.spyOn(XMLParser.prototype, 'parse');
    expect(() => parseRouteFile(xml(IMPORT_LIMITS.maxXmlDepth + 1), 'deep.kml')).toThrow(
      depthError,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it('rejects malformed self-closing end tags before parsing', () => {
    const xml = nestedRoute(IMPORT_LIMITS.maxXmlDepth + 1).replace('<kml>', '<kml></x/>');
    const parse = vi.spyOn(XMLParser.prototype, 'parse');
    expect(() => parseRouteFile(xml, 'malformed.kml')).toThrow('Invalid XML');
    expect(parse).not.toHaveBeenCalled();
  });

  it('rejects unknown declarations that the parser would treat as CDATA', () => {
    const folder = '<Folder><![foo/></Folder><!-- ]]> -->';
    const xml = `<kml>${folder.repeat(IMPORT_LIMITS.maxXmlDepth)}${line}</kml>`;
    const parse = vi.spyOn(XMLParser.prototype, 'parse');
    expect(() => parseRouteFile(xml, 'malformed.kml')).toThrow('Invalid XML');
    expect(parse).not.toHaveBeenCalled();
  });

  it.each(['"', "'"])(
    'matches the parser when a processing instruction quotes ?> with %s',
    (quote) => {
      const folder = `<Folder><?note value=${quote}?> </Folder> <?next value=${quote}?>`;
      const xml = `<kml>${folder.repeat(IMPORT_LIMITS.maxXmlDepth)}${line}</kml>`;
      const parse = vi.spyOn(XMLParser.prototype, 'parse');
      expect(() => parseRouteFile(xml, 'deep.kml')).toThrow(depthError);
      expect(parse).not.toHaveBeenCalled();
    },
  );
});
