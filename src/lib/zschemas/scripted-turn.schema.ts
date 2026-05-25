// Validation d'un tour scripted soumis depuis la page joueur (cf. Phase 5.4).
// HERMÉTIQUE : aucune dépendance vers $lib/i18n.

import { z } from 'zod';

export const addScriptedTurnSchema = z.object({
	session: z.string({ message: 'errors.addNode.missingSession' }).min(1),
	text: z.string({ message: 'errors.missingText' }).min(1)
});

export type AddScriptedTurnInput = z.infer<typeof addScriptedTurnSchema>;
