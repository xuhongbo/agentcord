import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.ts';

// Ensure data directory exists
mkdirSync(config.dataDir, { recursive: true });

export class Store<T> {
  private path: string;

  constructor(filename: string) {
    this.path = join(config.dataDir, filename);
  }

  read(): T | null {
    try {
      if (!existsSync(this.path)) return null;
      return JSON.parse(readFileSync(this.path, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  write(data: T): void {
    const tmp = join(tmpdir(), `threadcord-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    mkdirSync(dirname(this.path), { recursive: true });
    renameSync(tmp, this.path);
  }
}
