import { Injectable, OnModuleDestroy } from '@nestjs/common';

// Set when app.close() begins. onModuleDestroy is the first hook close()
// runs, ahead of the broker connections closing (dispose) and the publisher
// clients closing (onApplicationShutdown), so a job that settles at any point
// of the shutdown already sees it.
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
