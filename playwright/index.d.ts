import type { Locator, Page, TestInfo, TestType, PlaywrightTestArgs, PlaywrightTestOptions, PlaywrightWorkerArgs, PlaywrightWorkerOptions } from '@playwright/test';

export declare const JOURNEY: '@journey';
export declare const MASK_ATTRIBUTE: 'data-journeyboard-mask';

export interface JourneyboardOptions {
  /** A tag every test using snap must carry, e.g. '@journey'. */
  requireTag?: string;
  /** Runs once before the test body: fix the clock, freeze animations. */
  prepare?: (page: Page, testInfo: TestInfo) => Promise<void> | void;
  /** Runs before each picture. */
  beforeSnap?: (page: Page) => Promise<void> | void;
  /** CSS selectors blacked out on every picture, on top of [data-journeyboard-mask]. */
  mask?: string[];
  /** Whole scrollable page instead of the viewport. Default false. */
  fullPage?: boolean;
  /** JPEG quality, 1–100. Default 80. */
  quality?: number;
  /** What masked elements are painted with. Default a dark gray. */
  maskColor?: string;
}

export interface SnapOptions {
  /** What the screen is, as a person would say it: "Connect your calendar". */
  title?: string;
  /** The `flow/step` this screen is reached from, when that screen belongs to another test. */
  from?: string;
  /** Extra elements to black out on this picture. */
  mask?: Array<Locator | string>;
  fullPage?: boolean;
}

export type Snap = (name: string, options?: SnapOptions) => Promise<void>;

export interface SnapFixtures {
  snap: Snap;
  journeyboard: JourneyboardOptions;
  journeyShotsDir: string;
}

export declare function shotsDir(): string;

export declare function withSnap<T extends object, W extends object>(
  testBase: TestType<T, W>,
  defaults?: JourneyboardOptions
): TestType<T & SnapFixtures, W>;

export declare const test: TestType<PlaywrightTestArgs & PlaywrightTestOptions & SnapFixtures, PlaywrightWorkerArgs & PlaywrightWorkerOptions>;
export { expect } from '@playwright/test';
