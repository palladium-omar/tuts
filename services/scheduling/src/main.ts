import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@palladium/service-kit';
import { SessionsController, SessionsService } from './sessions.js';
void bootstrap({ name:'scheduling',port:4003,entitlement:'scheduling',controllers:[SessionsController],providers:[SessionsService],migrationsDir:fileURLToPath(new URL('../migrations',import.meta.url)) });
