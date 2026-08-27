import { Injectable } from '@nestjs/common';
import { DuplicateChecker } from './duplicate-checker.interface';

@Injectable()
export class InMemoryDuplicateChecker implements DuplicateChecker {
  private readonly seen = new Set<string>();

  async isDuplicate(eventId: string): Promise<boolean> {
    return this.seen.has(eventId);
  }

  async mark(eventId: string): Promise<void> {
    this.seen.add(eventId);
  }
}
