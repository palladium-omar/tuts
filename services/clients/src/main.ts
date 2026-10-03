import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@palladium/service-kit';
import { ClientsController } from './clients.controller.js';

await bootstrap({ name: 'clients', port: 4002, controllers: [ClientsController], entitlement: 'clients', migrationsDir: fileURLToPath(new URL('../migrations/', import.meta.url)) });
