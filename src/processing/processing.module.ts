import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { ValidationModule } from '../validation/validation.module';
import { ProcessingConsumer } from './processing.consumer';

@Module({
  imports: [MessagingModule, ValidationModule],
  controllers: [ProcessingConsumer],
})
export class ProcessingModule {}
