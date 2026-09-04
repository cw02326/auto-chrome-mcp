import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import fetch from 'node-fetch';
import { ensureStateDir, getStateDir, lockDownDir } from './security/auth-token';

/**
 * File handler for managing file uploads through the native messaging host
 */
export class FileHandler {
  private tempDir: string;
  private tempDirReady = false;

  constructor() {
    // 업로드 디렉터리는 사용자 전용이어야 한다.
    //
    // 예전에는 공유 tmp 의 고정 이름(`/tmp/chrome-mcp-uploads`)을 썼다. 같은 머신의 다른
    // 사용자가 그 경로를 먼저 만들고 파일명을 symlink 로 심어 두면, 업로드가 링크를 따라가
    // 링크 대상(남의 홈, 시스템 파일)을 덮어쓸 수 있었다. 이제 상태 디렉터리
    // (`~/.auto-chrome-mcp/uploads`, 소유자 전용) 아래를 쓰고, 그마저 실패하면
    // `mkdtempSync` 로 예측 불가능한 이름의 사용자 전용 디렉터리로 물러난다.
    //
    // 실제 생성은 첫 사용 시점(ensureTempDir)에 한다 — 모듈을 import 하기만 해도
    // 홈 디렉터리에 폴더가 생기지 않게.
    this.tempDir = path.join(getStateDir(), 'uploads');
  }

  /** 현재 업로드 디렉터리 (테스트·진단용). */
  get tempDirectory(): string {
    return this.tempDir;
  }

  /** 업로드 디렉터리를 만들고 소유자 전용으로 잠근다. 실패하면 사용자 전용 tmp 로 물러난다. */
  private ensureTempDir(): string {
    if (this.tempDirReady) return this.tempDir;

    const state = ensureStateDir();
    if (state.ok) {
      try {
        fs.mkdirSync(this.tempDir, { recursive: true, mode: 0o700 });
        const locked = lockDownDir(this.tempDir);
        if (!locked.ok) {
          console.error('[upload] upload dir permission lockdown failed:', locked.error);
        }
        this.tempDirReady = true;
        return this.tempDir;
      } catch (e: any) {
        console.error('[upload] failed to create upload dir under state dir:', e?.message || e);
      }
    }

    this.tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-mcp-uploads-'));
    const locked = lockDownDir(this.tempDir);
    if (!locked.ok) {
      console.error('[upload] fallback upload dir permission lockdown failed:', locked.error);
    }
    this.tempDirReady = true;
    return this.tempDir;
  }

  /**
   * temp 디렉터리 안에 파일을 새로 만들어 쓴다.
   *
   * `openSync(..., 'wx')` 로만 만든다 — 그 경로에 이미 무엇이 있으면 실패하므로 미리
   * 심어 둔 symlink 를 절대 따라가지 않는다. 같은 이름의 일반 파일이 있으면(같은 파일을
   * 다시 업로드) 지우고 새로 만들어 예전의 덮어쓰기 동작을 유지한다. symlink·디렉터리 등
   * 일반 파일이 아닌 것은 거절한다.
   */
  private writeTempFile(filePath: string, buffer: Buffer): void {
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(filePath);
    } catch {
      existing = null;
    }
    if (existing) {
      if (existing.isSymbolicLink()) {
        throw new Error(`Refusing to write through a symbolic link: ${filePath}`);
      }
      if (!existing.isFile()) {
        throw new Error(`Upload target exists and is not a regular file: ${filePath}`);
      }
      fs.unlinkSync(filePath);
    }

    const fd = fs.openSync(filePath, 'wx', 0o600);
    try {
      fs.writeSync(fd, buffer);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * temp 디렉터리 안의 안전한 절대 경로를 만든다.
   *
   * fileName 은 "파일명"이어야 한다. 예전에는 path.join(tempDir, fileName) 을 그대로 써서
   * `../../x` 같은 값이 오면 temp 밖 아무 곳에나 파일을 썼다.
   *
   * 요청마다 무작위 이름의 하위 디렉터리(슬롯)를 하나 만들고 그 안에 넣는다.
   *
   * 왜 필요한가: 네이티브 호스트는 들어온 메시지를 await 하지 않고 처리한다
   * (native-messaging-host.ts 의 processAvailable). 그래서 같은 fileName 으로 두 건이
   * 동시에 들어오면 다운로드·디코딩의 await 지점에서 서로 끼어들었고, 먼저 끝난 쪽이
   * 돌려받은 경로에 나중 쪽의 내용이 들어 있었다. 확장의 기본 fileName 이
   * 'uploaded-file' 고정이라 실제로 잘 부딪히는 조합이다.
   *
   * 왜 접미사가 아니라 하위 디렉터리인가: 반환 경로는 확장이 그대로 CDP 업로드에 넘기고,
   * 웹페이지에는 그 경로의 basename 이 파일명으로 보인다. 접미사를 붙이면 페이지가 보는
   * 파일명이 바뀐다 (확장자 검사·표시명에 영향). 슬롯 방식은 파일명을 그대로 두면서
   * 충돌만 없앤다. 호출자는 반환된 filePath 를 그대로 쓰므로 양쪽 다 호환되지만,
   * 파일명이 보존되는 쪽을 택했다.
   */
  private resolveTempFilePath(fileName: unknown): string {
    const tempDir = this.ensureTempDir();
    const raw = typeof fileName === 'string' ? fileName.trim() : '';
    if (!raw) {
      throw new Error('Invalid fileName: must be a non-empty file name');
    }
    if (raw.includes('\0')) {
      throw new Error('Invalid fileName: contains a null byte');
    }
    // 경로 구분자가 섞여 있으면 조용히 잘라내지 않고 거절한다 (호출자가 착각하지 않게).
    if (raw.includes('/') || raw.includes('\\')) {
      throw new Error(`Invalid fileName: path separators are not allowed (${raw})`);
    }
    const base = path.basename(raw);
    if (!base || base === '.' || base === '..' || base !== raw) {
      throw new Error(`Invalid fileName: must be a plain file name (${raw})`);
    }

    // recursive:false — 누가 그 이름을 미리 심어 뒀으면 EEXIST 로 실패한다 (따라가지 않는다).
    const slot = path.join(tempDir, crypto.randomBytes(8).toString('hex'));
    fs.mkdirSync(slot, { mode: 0o700 });

    const resolved = path.resolve(slot, base);
    if (!this.isInsideTempDir(resolved)) {
      throw new Error(`Invalid fileName: resolves outside the temp directory (${raw})`);
    }
    return resolved;
  }

  /**
   * canonical containment 검사. `startsWith(tempDir)` 는 형제 디렉터리
   * (chrome-mcp-uploads-evil) 까지 허용했다.
   */
  private isInsideTempDir(candidate: string): boolean {
    const root = path.resolve(this.tempDir);
    const target = path.resolve(candidate);
    const rel = path.relative(root, target);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  /**
   * Handle file preparation request from the extension
   */
  async handleFileRequest(request: any): Promise<any> {
    const { action, fileUrl, base64Data, fileName, filePath, traceFilePath, insightName } = request;

    try {
      switch (action) {
        case 'prepareFile':
          if (fileUrl) {
            return await this.downloadFile(fileUrl, fileName);
          } else if (base64Data) {
            return await this.saveBase64File(base64Data, fileName);
          } else if (filePath) {
            return await this.verifyFile(filePath);
          }
          break;

        case 'readBase64File': {
          if (!filePath) return { success: false, error: 'filePath is required' };
          return await this.readBase64File(filePath);
        }

        case 'cleanupFile':
          return await this.cleanupFile(filePath);

        case 'analyzeTrace': {
          const targetPath = traceFilePath || filePath;
          if (!targetPath) {
            return { success: false, error: 'traceFilePath is required' };
          }
          try {
            // With tsconfig moduleResolution=NodeNext, relative ESM imports need explicit .js extension
            const { analyzeTraceFile } = await import('./trace-analyzer.js');
            const res = await analyzeTraceFile(targetPath, insightName);
            return { success: true, ...res };
          } catch (e: any) {
            return { success: false, error: e?.message || String(e) };
          }
        }

        default:
          return {
            success: false,
            error: `Unknown file action: ${action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Download a file from URL and save to temp directory
   */
  private async downloadFile(fileUrl: string, fileName?: string): Promise<any> {
    try {
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download file: ${response.statusText}`);
      }

      // Generate filename if not provided
      const filePath = this.resolveTempFilePath(fileName || this.generateFileName(fileUrl));
      const finalFileName = path.basename(filePath);

      // Get the file buffer
      const buffer = await response.buffer();

      // Save to file (symlink 을 따라가지 않는 경로로만)
      this.writeTempFile(filePath, buffer);

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (error) {
      throw new Error(`Failed to download file from URL: ${error}`);
    }
  }

  /**
   * Save base64 data as a file
   */
  private async saveBase64File(base64Data: string, fileName?: string): Promise<any> {
    try {
      // Remove data URL prefix if present
      const base64Content = base64Data.replace(/^data:.*?;base64,/, '');

      // Convert base64 to buffer
      const buffer = Buffer.from(base64Content, 'base64');

      // Generate filename if not provided
      const filePath = this.resolveTempFilePath(fileName || `upload-${Date.now()}.bin`);
      const finalFileName = path.basename(filePath);

      // Save to file (symlink 을 따라가지 않는 경로로만)
      this.writeTempFile(filePath, buffer);

      return {
        success: true,
        filePath: filePath,
        fileName: finalFileName,
        size: buffer.length,
      };
    } catch (error) {
      throw new Error(`Failed to save base64 file: ${error}`);
    }
  }

  /**
   * Verify that a file exists and is accessible
   */
  private async verifyFile(filePath: string): Promise<any> {
    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      // Get file stats
      const stats = fs.statSync(filePath);

      // Check if it's actually a file
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }

      // Check if file is readable
      fs.accessSync(filePath, fs.constants.R_OK);

      return {
        success: true,
        filePath: filePath,
        fileName: path.basename(filePath),
        size: stats.size,
      };
    } catch (error) {
      throw new Error(`Failed to verify file: ${error}`);
    }
  }

  /**
   * Read file content and return as base64 string
   */
  private async readBase64File(filePath: string): Promise<any> {
    try {
      if (!fs.existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        throw new Error(`Path is not a file: ${filePath}`);
      }
      const buf = fs.readFileSync(filePath);
      const base64 = buf.toString('base64');
      return {
        success: true,
        filePath,
        fileName: path.basename(filePath),
        size: stats.size,
        base64Data: base64,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Clean up a temporary file
   */
  private async cleanupFile(filePath: string): Promise<any> {
    try {
      // Only allow cleanup of files in our temp directory (canonical containment)
      if (typeof filePath !== 'string' || !filePath.trim() || !this.isInsideTempDir(filePath)) {
        return {
          success: false,
          error: 'Can only cleanup files in temp directory',
        };
      }

      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      // 파일이 들어 있던 슬롯 디렉터리가 비었으면 같이 치운다 (best-effort).
      const slot = path.dirname(path.resolve(filePath));
      if (slot !== path.resolve(this.tempDir) && this.isInsideTempDir(slot)) {
        try {
          fs.rmdirSync(slot);
        } catch {
          /* 아직 뭔가 남아 있으면 그대로 둔다 */
        }
      }

      return {
        success: true,
        message: 'File cleaned up successfully',
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to cleanup file: ${error}`,
      };
    }
  }

  /**
   * Generate a filename from URL or create a unique one
   */
  private generateFileName(url?: string): string {
    if (url) {
      try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const basename = path.basename(pathname);
        if (basename && basename !== '/') {
          // 충돌 회피용 무작위 접미사는 더 이상 붙이지 않는다 — 요청마다 슬롯 디렉터리가
          // 다르므로 이름이 겹쳐도 부딪히지 않고, 원래 파일명이 그대로 업로드에 보인다.
          return basename;
        }
      } catch {
        // Invalid URL, fall through to generate random name
      }
    }

    // Generate random filename
    return `upload-${crypto.randomBytes(8).toString('hex')}.bin`;
  }

  /**
   * Clean up old temporary files (older than 1 hour)
   */
  cleanupOldFiles(): void {
    try {
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;

      if (!fs.existsSync(this.tempDir)) return;
      const entries = fs.readdirSync(this.tempDir);
      for (const entry of entries) {
        const entryPath = path.join(this.tempDir, entry);
        // lstat — 링크를 따라가 엉뚱한 대상을 지우지 않는다.
        const stats = fs.lstatSync(entryPath);
        if (now - stats.mtimeMs <= oneHour) continue;
        // 업로드 1건 = 슬롯 디렉터리 1개라 디렉터리도 지울 수 있어야 한다.
        if (stats.isDirectory()) {
          fs.rmSync(entryPath, { recursive: true, force: true });
        } else {
          fs.unlinkSync(entryPath);
        }
        // Use stderr to avoid polluting stdout (Native Messaging protocol)
        console.error(`Cleaned up old temp entry: ${entry}`);
      }
    } catch (error) {
      console.error('Error cleaning up old files:', error);
    }
  }
}

export default new FileHandler();
