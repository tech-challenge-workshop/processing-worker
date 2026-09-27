import { Injectable, OnModuleDestroy } from '@nestjs/common';

// Set when app.close() begins. onModuleDestroy is the first hook close()
// runs, ahead of the broker connections closing (dispose) and the publisher
// clients closing (onApplicationShutdown), so a job that settles at any point
// of the shutdown already sees it.
//
// Accepted window (ROB-07, decided 2026-09-26): the consumer reads the flag
// once, after the packager settles. A job that passed that check just before
// shutdown began may still publish ProcessingCompleted, and if close() ends
// before its ack, the redelivery may publish it again. The Catalog drops the
// repeat by eventId (AD-010), so the window is documented, not closed.
@Injectable()
export class ShutdownSignal implements OnModuleDestroy {
  private closing = false;

  get isClosing(): boolean {
    return this.closing;
  }

  onModuleDestroy(): void {
    this.closing = true;
  }
}
