import type { ArchitectureScene } from '../types';
import { clientsScene } from './clients';
import { gitRuntimeScene } from './git-runtime';
import { overviewScene } from './overview';
import { pluginsScene } from './plugins';
import { supervisorScene } from './supervisor';

export { evidenceLabel, SOURCE_SNAPSHOT } from './shared';

export const scenes = [
    overviewScene,
    clientsScene,
    gitRuntimeScene,
    pluginsScene,
    supervisorScene,
] as const satisfies readonly ArchitectureScene[];

export const sceneById = new Map(scenes.map(scene => [scene.id, scene]));

export const requireScene = (sceneId: string): ArchitectureScene => {
    const scene = sceneById.get(sceneId);
    if (scene === undefined) throw new Error(`Unknown scene: ${sceneId}`);
    return scene;
};
