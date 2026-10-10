import 'reflect-metadata';
import {PlanningController} from './planning.controller.js';
import {PlanningService} from './planning.service.js';
import {PlanningStudentMerges} from './student-merges.js';
export const appOptions={name:'planning',port:4009,entitlement:'planning',controllers:[PlanningController],providers:[PlanningService,PlanningStudentMerges]};
