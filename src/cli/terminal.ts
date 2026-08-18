import type {RenderOptions} from 'ink';

export const INTERACTIVE_RENDER_OPTIONS = Object.freeze({
  exitOnCtrlC: false,
  alternateScreen: true
}) satisfies Readonly<RenderOptions>;
