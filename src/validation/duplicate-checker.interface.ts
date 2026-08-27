export interface DuplicateChecker {
  isDuplicate(eventId: string): Promise<boolean>;
  mark(eventId: string): Promise<void>;
}
