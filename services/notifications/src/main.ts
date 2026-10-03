import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@palladium/service-kit';
import { NotificationConsumer,NotificationsController,NotificationsService } from './notifications.js';
void bootstrap({name:'notifications',port:4007,entitlement:'notifications',controllers:[NotificationsController],providers:[NotificationConsumer,NotificationsService],migrationsDir:fileURLToPath(new URL('../migrations',import.meta.url))});
