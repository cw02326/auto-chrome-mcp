#!/usr/bin/env node
import path from 'path';
import { COMMAND_NAME } from './constant';
import { colorText, registerWithElevatedPermissions, writeNodePathFile } from './utils';

/**
 * Main entry — registers the Native Messaging host manifest.
 */
async function main(): Promise<void> {
  console.log(colorText(`${COMMAND_NAME} Native Messaging host 등록 중...`, 'blue'));

  try {
    // Write Node.js path before registration
    writeNodePathFile(path.join(__dirname, '..'));

    await registerWithElevatedPermissions();
    console.log(
      colorText('등록 성공! Chrome 확장이 Native Messaging 으로 로컬 서비스와 통신 가능.', 'green'),
    );
  } catch (error: any) {
    console.error(colorText(`등록 실패: ${error.message}`, 'red'));
    process.exit(1);
  }
}

main();
