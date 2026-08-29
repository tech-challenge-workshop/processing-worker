import { Injectable } from '@nestjs/common';

@Injectable()
export class RabbitmqHealthService {
  private rabbitmqConnected = false;

  setConnected(connected: boolean): void {
    this.rabbitmqConnected = connected;
  }

  isHealthy(): boolean {
    return this.rabbitmqConnected;
  }
}
