// Génère un identifiant PocketBase conforme au pattern requis par toutes les
// collections du projet : exactement 15 caractères de l'alphabet [a-z0-9]
// (cf. db/schema.json, champ `id` de chaque collection avec min/max=15 et
// pattern ^[a-z0-9]+$). Pré-générer ces IDs côté serveur permet de connecter les
// FK entre records créés dans le même batch transactionnel.

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LENGTH = 15;

export function pbId(): string {
	const bytes = new Uint8Array(LENGTH);
	crypto.getRandomValues(bytes);
	let out = '';
	for (let i = 0; i < LENGTH; i++) {
		out += ALPHABET[bytes[i] % ALPHABET.length];
	}
	return out;
}
