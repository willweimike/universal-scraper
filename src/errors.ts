import type { ElementRef, ErrorCode, ScraperErrorShape } from './protocol.js';

export class ScraperError extends Error implements ScraperErrorShape {
  code: ErrorCode;
  recoverable: boolean;
  hint: string;
  candidates?: ElementRef[];

  constructor(shape: ScraperErrorShape) {
    super(shape.message);
    this.name = 'ScraperError';
    this.code = shape.code;
    this.recoverable = shape.recoverable;
    this.hint = shape.hint;
    this.candidates = shape.candidates;
  }

  static from(code: ErrorCode, message: string, hint: string, recoverable = false): ScraperError {
    return new ScraperError({ code, message, hint, recoverable });
  }

  toShape(): ScraperErrorShape {
    const { code, message, recoverable, hint, candidates } = this;
    return { code, message, recoverable, hint, ...(candidates ? { candidates } : {}) };
  }
}

export function toShape(err: unknown): ScraperErrorShape {
  if (err instanceof ScraperError) return err.toShape();
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'internal', message, recoverable: false, hint: 'This is a bug in the scraper; report it with the message.' };
}
