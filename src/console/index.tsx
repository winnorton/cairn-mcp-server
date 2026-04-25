#!/usr/bin/env node
import { render } from 'ink';
import App from './App.js';

const isTTY = process.stdin.isTTY === true;

if (isTTY) {
  // Interactive mode with full keyboard input
  const { waitUntilExit } = render(<App />);
  waitUntilExit().then(() => process.exit(0));
} else {
  // Non-interactive: render once, capture output, exit
  const { unmount } = render(<App />, {
    patchConsole: false,
  });
  // Give the data hook time to do one refresh cycle
  setTimeout(() => {
    unmount();
    process.exit(0);
  }, 3000);
}
