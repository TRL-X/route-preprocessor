import { describe, expect, it } from 'vitest';
import { DEFAULT_TARGET_DIRECTORY, uploadPath } from '../../src/features/export/upload-path';

describe('device upload paths', () => {
  it('appends the generated filename to the default or configured directory', () => {
    expect(uploadPath(DEFAULT_TARGET_DIRECTORY, 'Forest trail.rte')).toBe(
      '/SD:/routes/Forest trail.rte',
    );
    expect(uploadPath(' /lfs/routes ', '山路.rte')).toBe('/lfs/routes/山路.rte');
    expect(uploadPath('/', 'route.rte')).toBe('/route.rte');
  });

  it.each(['', 'routes/', '/SD:/../routes', '/SD:/./routes', '/SD:\\routes', '/SD:/\n'])(
    'rejects an invalid directory: %j',
    (directory) => {
      expect(() => uploadPath(directory, 'route.rte')).toThrow('bluetooth.invalidDirectory');
    },
  );

  it('measures the complete path in UTF-8 bytes, including its filename', () => {
    expect(() => uploadPath('/SD:/routes', '山'.repeat(80) + '.rte')).toThrow(
      'bluetooth.pathTooLong',
    );
    expect(() => uploadPath('/SD:/routes', 'a'.repeat(80) + '.rte')).not.toThrow();
  });
});
