import { describe, expect, test, afterEach } from '@jest/globals';
import {
  getChromeMcpHost,
  getChromeMcpPort,
  getChromeMcpUrl,
  SERVER_CONFIG,
  NATIVE_SERVER_PORT,
} from './index';

const ENV_KEYS = ['CHROME_MCP_HOST', 'CHROME_MCP_PORT', 'MCP_HTTP_PORT'] as const;

describe('constant env resolution — regression for upstream PR #313', () => {
  // 회귀 case 8: CHROME_MCP_HOST=0.0.0.0 env 으로 LAN 노출 가능해야 함
  afterEach(() => {
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
  });

  describe('getChromeMcpHost()', () => {
    test('returns SERVER_CONFIG.HOST when CHROME_MCP_HOST unset', () => {
      delete process.env.CHROME_MCP_HOST;
      expect(getChromeMcpHost()).toBe(SERVER_CONFIG.HOST);
    });

    test('returns env value when CHROME_MCP_HOST set (LAN binding scenario)', () => {
      process.env.CHROME_MCP_HOST = '0.0.0.0';
      expect(getChromeMcpHost()).toBe('0.0.0.0');
    });

    test('returns env value for arbitrary host', () => {
      process.env.CHROME_MCP_HOST = '192.168.1.100';
      expect(getChromeMcpHost()).toBe('192.168.1.100');
    });
  });

  describe('getChromeMcpPort()', () => {
    test('returns NATIVE_SERVER_PORT default when both env unset', () => {
      delete process.env.CHROME_MCP_PORT;
      delete process.env.MCP_HTTP_PORT;
      expect(getChromeMcpPort()).toBe(NATIVE_SERVER_PORT);
    });

    test('CHROME_MCP_PORT takes priority over MCP_HTTP_PORT', () => {
      process.env.CHROME_MCP_PORT = '13000';
      process.env.MCP_HTTP_PORT = '14000';
      expect(getChromeMcpPort()).toBe(13000);
    });

    test('MCP_HTTP_PORT used when CHROME_MCP_PORT unset (backward-compat)', () => {
      delete process.env.CHROME_MCP_PORT;
      process.env.MCP_HTTP_PORT = '14000';
      expect(getChromeMcpPort()).toBe(14000);
    });

    test('invalid port falls back to default', () => {
      process.env.CHROME_MCP_PORT = 'not-a-number';
      expect(getChromeMcpPort()).toBe(NATIVE_SERVER_PORT);
    });

    test('out-of-range port falls back to default', () => {
      process.env.CHROME_MCP_PORT = '70000';
      expect(getChromeMcpPort()).toBe(NATIVE_SERVER_PORT);
    });
  });

  describe('getChromeMcpUrl()', () => {
    test('combines host + port + /mcp path', () => {
      delete process.env.CHROME_MCP_HOST;
      delete process.env.CHROME_MCP_PORT;
      expect(getChromeMcpUrl()).toBe(`http://${SERVER_CONFIG.HOST}:${NATIVE_SERVER_PORT}/mcp`);
    });

    test('LAN scenario: host=0.0.0.0 + custom port', () => {
      process.env.CHROME_MCP_HOST = '0.0.0.0';
      process.env.CHROME_MCP_PORT = '12999';
      expect(getChromeMcpUrl()).toBe('http://0.0.0.0:12999/mcp');
    });
  });
});
