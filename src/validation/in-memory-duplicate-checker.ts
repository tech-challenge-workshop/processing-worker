import { Injectable } from '@nestjs/common';
import { DuplicateChecker } from './duplicate-checker.interface';

@Injectable()
export class InMemoryDuplicateChecker implements DuplicateChecker {
  private readonly seen = new Set<string>();

  isDuplicate(eventId: string): Promise<boolean> {
    return Promise.resolve(this.seen.has(eventId));
  }

  mark(eventId: string): Promise<void> {
    this.seen.add(eventId);
    return Promise.resolve();
  }
}
