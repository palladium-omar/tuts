import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { bootstrap } from '@palladium/service-kit';
import { PaymentsController, PaymentsService } from './payments.js';
bootstrap({name:'payments',port:4006,controllers:[PaymentsController],providers:[PaymentsService],migrationsDir:fileURLToPath(new URL('../migrations',import.meta.url)),entitlement:'payments'}).catch(error=>{console.error(error);process.exit(1);});
