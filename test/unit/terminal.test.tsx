import {PassThrough} from 'node:stream';
import {render, Text, useApp, useInput} from 'ink';
import React, {useEffect} from 'react';
import {describe, expect, it, vi} from 'vitest';
import {INTERACTIVE_RENDER_OPTIONS} from '../../src/cli/terminal.js';

const ENTER_ALTERNATE_SCREEN = '\u001B[?1049h';
const EXIT_ALTERNATE_SCREEN = '\u001B[?1049l';
const SHOW_CURSOR = '\u001B[?25h';

describe('interactive terminal lifecycle', () => {
  it('enables alternate-screen rendering with manual Ctrl+C handling', () => {
    expect(INTERACTIVE_RENDER_OPTIONS).toEqual({
      exitOnCtrlC: false,
      alternateScreen: true
    });
    expect(Object.isFrozen(INTERACTIVE_RENDER_OPTIONS)).toBe(true);
  });

  it('enters before the first frame and restores the screen and cursor on unmount', async () => {
    const stdout = ttyOutput();
    const stderr = ttyOutput();
    const stdin = ttyInput();
    let output = '';
    stdout.on('data', chunk => {
      output += chunk.toString();
    });

    const instance = render(<InteractiveFixture />, {
      ...INTERACTIVE_RENDER_OPTIONS,
      interactive: true,
      patchConsole: false,
      stdin,
      stdout,
      stderr
    });
    await instance.waitUntilRenderFlush();
    instance.unmount();
    await instance.waitUntilExit();

    const enterIndex = output.indexOf(ENTER_ALTERNATE_SCREEN);
    const frameIndex = output.indexOf('Only dashboard content');
    const exitIndex = output.lastIndexOf(EXIT_ALTERNATE_SCREEN);
    const cursorIndex = output.lastIndexOf(SHOW_CURSOR);

    expect(enterIndex).toBeGreaterThanOrEqual(0);
    expect(frameIndex).toBeGreaterThan(enterIndex);
    expect(exitIndex).toBeGreaterThan(frameIndex);
    expect(cursorIndex).toBeGreaterThan(exitIndex);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('restores the primary screen when the renderer exits with an error', async () => {
    const stdout = ttyOutput();
    const stderr = ttyOutput();
    const stdin = ttyInput();
    let output = '';
    stdout.on('data', chunk => {
      output += chunk.toString();
    });

    const instance = render(<ErrorFixture />, {
      ...INTERACTIVE_RENDER_OPTIONS,
      interactive: true,
      patchConsole: false,
      stdin,
      stdout,
      stderr
    });
    await expect(instance.waitUntilExit()).rejects.toThrow(
      'fixture renderer failure'
    );

    expect(output).toContain(ENTER_ALTERNATE_SCREEN);
    expect(output).toContain(EXIT_ALTERNATE_SCREEN);
    expect(output.lastIndexOf(SHOW_CURSOR)).toBeGreaterThan(
      output.lastIndexOf(EXIT_ALTERNATE_SCREEN)
    );
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });
});

function InteractiveFixture(): React.JSX.Element {
  useInput(() => undefined);
  return <Text>Only dashboard content</Text>;
}

function ErrorFixture(): React.JSX.Element {
  const {exit} = useApp();
  useInput(() => undefined);
  useEffect(() => {
    exit(new Error('fixture renderer failure'));
  }, [exit]);
  return <Text>Failing dashboard content</Text>;
}

function ttyOutput(): NodeJS.WriteStream {
  const stream = new PassThrough();
  Object.assign(stream, {
    isTTY: true,
    columns: 80,
    rows: 24
  });
  return stream as unknown as NodeJS.WriteStream;
}

function ttyInput(): NodeJS.ReadStream & {
  setRawMode: ReturnType<typeof vi.fn>;
} {
  const stream = new PassThrough();
  const setRawMode = vi.fn(() => stream);
  Object.assign(stream, {
    isTTY: true,
    isRaw: false,
    setRawMode,
    ref: vi.fn(),
    unref: vi.fn()
  });
  return stream as unknown as NodeJS.ReadStream & {
    setRawMode: ReturnType<typeof vi.fn>;
  };
}
