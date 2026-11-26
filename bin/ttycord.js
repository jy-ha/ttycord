#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((error) => {
  console.error(`오류: ${error.message || error}`);
  process.exitCode = 1;
});
