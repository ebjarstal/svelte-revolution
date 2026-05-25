// Helper de dispatch entre moteur free et moteur scripted (cf. Phase 5.4).
// Extrait dans un module à part pour rester testable sous Vitest — `+page.server.ts`
// importe `$env/static/private` qui n'est pas résolu par Vitest, donc on ne peut
// pas charger directement le fichier de route.
//
// Le sélecteur est volontairement permissif sur l'input (tout objet avec un
// `expand?.scenario?.engine?`) pour qu'il soit appelable depuis un sessionData PB
// éventuellement faiblement typé.

export interface SessionWithScenarioExpand {
	expand?: {
		scenario?: { engine?: string } | null;
	} | null;
}

export function isScriptedScenario(session: SessionWithScenarioExpand | null | undefined): boolean {
	return session?.expand?.scenario?.engine === 'scripted';
}
