// Minimal YAML parser limité au sous-ensemble utilisé par les fixtures scenarios/fixtures/*.yaml.
// Volontairement hermétique (aucune dépendance externe) — cf. docs/narrative-engine-design.md §8.

export type YamlValue =
	| string
	| number
	| boolean
	| null
	| YamlValue[]
	| { [key: string]: YamlValue };

interface Line {
	raw: string;       // ligne d'origine (whitespace droit déjà retiré)
	indent: number;    // nombre d'espaces en tête
	content: string;   // contenu utile (sans indent ni commentaire fin de ligne)
	blank: boolean;    // ligne vide ou commentaire pur
}

class YamlParseError extends Error {
	constructor(message: string, public line: number) {
		super(`YAML parse error (line ${line + 1}): ${message}`);
	}
}

class Parser {
	private lines: Line[];
	private pos = 0;
	private anchors: Record<string, YamlValue> = {};

	constructor(text: string) {
		const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
		this.lines = normalized.split('\n').map(preprocessLine);
	}

	parseRoot(): YamlValue {
		this.skipBlanks();
		if (this.pos >= this.lines.length) return null;
		return this.parseValueAt(-1);
	}

	private skipBlanks(): void {
		while (this.pos < this.lines.length && this.lines[this.pos].blank) this.pos++;
	}

	private peek(): Line | null {
		this.skipBlanks();
		return this.pos < this.lines.length ? this.lines[this.pos] : null;
	}

	// Parse une valeur dont le contenu doit avoir une indentation > parentIndent.
	private parseValueAt(parentIndent: number): YamlValue {
		const line = this.peek();
		if (!line || line.indent <= parentIndent) return null;
		const myIndent = line.indent;
		if (line.content.startsWith('- ') || line.content === '-') {
			return this.parseSequence(myIndent);
		}
		if (isMappingEntry(line.content)) {
			return this.parseMapping(myIndent);
		}
		// scalaire isolé sur une ligne (rare ici)
		this.pos++;
		return this.parseScalar(line.content, line);
	}

	private parseMapping(indent: number): { [k: string]: YamlValue } {
		const map: { [k: string]: YamlValue } = {};
		while (true) {
			const line = this.peek();
			if (!line || line.indent !== indent || !isMappingEntry(line.content)) break;
			this.pos++;
			this.consumeMapEntry(map, line.content, indent, line);
		}
		return map;
	}

	private parseSequence(indent: number): YamlValue[] {
		const items: YamlValue[] = [];
		while (true) {
			const line = this.peek();
			if (!line || line.indent !== indent) break;
			const c = line.content;
			if (!c.startsWith('- ') && c !== '-') break;
			this.pos++;
			const after = c === '-' ? '' : c.slice(2);
			if (after === '') {
				// l'item est nested
				items.push(this.parseValueAt(indent));
			} else if (isMappingEntry(after)) {
				// mapping inline démarrant après le tiret
				items.push(this.parseInlineMapping(indent, after, line));
			} else {
				items.push(this.parseScalar(after, line));
			}
		}
		return items;
	}

	private parseInlineMapping(
		seqIndent: number,
		firstEntry: string,
		anchorLine: Line
	): { [k: string]: YamlValue } {
		const map: { [k: string]: YamlValue } = {};
		// Les clés-frères sont alignées sur la première clé (seqIndent + 2)
		const keyIndent = seqIndent + 2;
		this.consumeMapEntry(map, firstEntry, keyIndent, anchorLine);
		while (true) {
			const line = this.peek();
			if (!line || line.indent !== keyIndent || !isMappingEntry(line.content)) break;
			this.pos++;
			this.consumeMapEntry(map, line.content, keyIndent, line);
		}
		return map;
	}

	private consumeMapEntry(
		map: { [k: string]: YamlValue },
		content: string,
		keyIndent: number,
		line: Line
	): void {
		const [key, restRaw] = splitKeyValue(content, line);
		const rest = restRaw.trim();
		if (rest === '') {
			map[key] = this.parseValueAt(keyIndent);
			return;
		}
		// bloc littéral éventuellement précédé d'une ancre
		const blockHeader = matchBlockLiteralHeader(rest);
		if (blockHeader) {
			const literal = this.parseLiteralBlock(keyIndent);
			if (blockHeader.anchor) this.anchors[blockHeader.anchor] = literal;
			map[key] = literal;
			return;
		}
		map[key] = this.parseScalar(rest, line);
	}

	private parseLiteralBlock(parentIndent: number): string {
		const collected: string[] = [];
		let blockIndent = -1;
		while (this.pos < this.lines.length) {
			const line = this.lines[this.pos];
			if (line.blank) {
				collected.push('');
				this.pos++;
				continue;
			}
			if (line.indent <= parentIndent) break;
			if (blockIndent === -1) blockIndent = line.indent;
			const stripped = line.raw.slice(Math.min(blockIndent, line.raw.length));
			collected.push(stripped);
			this.pos++;
		}
		// strip trailing blank lines (mode `|` clip-final)
		while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
		return collected.join('\n') + '\n';
	}

	private parseScalar(text: string, line: Line): YamlValue {
		const trimmed = text.trim();
		if (trimmed.startsWith('*')) {
			const name = trimmed.slice(1).trim();
			if (!(name in this.anchors)) {
				throw new YamlParseError(`unknown anchor: ${name}`, this.lines.indexOf(line));
			}
			return this.anchors[name];
		}
		const anchorMatch = trimmed.match(/^&([\w-]+)\s+(.*)$/s);
		if (anchorMatch) {
			const value = parseInlineValue(anchorMatch[2]);
			this.anchors[anchorMatch[1]] = value;
			return value;
		}
		return parseInlineValue(trimmed);
	}
}

function matchBlockLiteralHeader(rest: string): { anchor: string | null } | null {
	// `|` ou `&name |` (variantes |-, |+ acceptées)
	const anchored = rest.match(/^&([\w-]+)\s+\|[+-]?$/);
	if (anchored) return { anchor: anchored[1] };
	if (rest === '|' || rest === '|-' || rest === '|+') return { anchor: null };
	return null;
}

function preprocessLine(raw: string): Line {
	const trimmedRight = raw.replace(/\s+$/, '');
	let indent = 0;
	while (indent < trimmedRight.length && trimmedRight[indent] === ' ') indent++;
	const after = trimmedRight.slice(indent);
	if (after === '' || after.startsWith('#')) {
		return { raw: trimmedRight, indent: 0, content: '', blank: true };
	}
	const content = stripTrailingComment(after).replace(/\s+$/, '');
	return { raw: trimmedRight, indent, content, blank: false };
}

function stripTrailingComment(s: string): string {
	let inStr: '"' | "'" | null = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (c === inStr && s[i - 1] !== '\\') inStr = null;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = c;
			continue;
		}
		if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) return s.slice(0, i);
	}
	return s;
}

function isMappingEntry(content: string): boolean {
	try {
		splitKeyValue(content);
		return true;
	} catch {
		return false;
	}
}

function splitKeyValue(content: string, line?: Line): [string, string] {
	let depth = 0;
	let inStr: '"' | "'" | null = null;
	for (let i = 0; i < content.length; i++) {
		const c = content[i];
		if (inStr) {
			if (c === inStr && content[i - 1] !== '\\') inStr = null;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = c;
			continue;
		}
		if (c === '[' || c === '{') depth++;
		else if (c === ']' || c === '}') depth--;
		else if (c === ':' && depth === 0) {
			const next = i + 1 < content.length ? content[i + 1] : '';
			if (next === '' || next === ' ' || next === '\t') {
				return [unquoteKey(content.slice(0, i).trim()), content.slice(i + 1)];
			}
		}
	}
	throw new YamlParseError(`no mapping separator in: ${content}`, line ? -1 : -1);
}

function unquoteKey(k: string): string {
	if (k.startsWith('"') && k.endsWith('"')) return k.slice(1, -1);
	if (k.startsWith("'") && k.endsWith("'")) return k.slice(1, -1);
	return k;
}

function parseInlineValue(raw: string): YamlValue {
	const s = raw.trim();
	if (s === '') return null;
	if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
	if (s === 'true' || s === 'True' || s === 'TRUE') return true;
	if (s === 'false' || s === 'False' || s === 'FALSE') return false;
	if (s.startsWith('"') && s.endsWith('"')) return parseDoubleQuoted(s);
	if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
	if (s.startsWith('[') && s.endsWith(']')) return parseFlowSeq(s);
	if (s.startsWith('{') && s.endsWith('}')) return parseFlowMap(s);
	if (/^-?\d+$/.test(s)) return parseInt(s, 10);
	if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
	return s;
}

function parseDoubleQuoted(s: string): string {
	const inner = s.slice(1, -1);
	return inner.replace(/\\(.)/g, (_m, c) => {
		if (c === 'n') return '\n';
		if (c === 't') return '\t';
		if (c === 'r') return '\r';
		if (c === '"') return '"';
		if (c === '\\') return '\\';
		return c;
	});
}

function parseFlowSeq(s: string): YamlValue[] {
	const inner = s.slice(1, -1).trim();
	if (inner === '') return [];
	return splitFlowItems(inner).map(parseInlineValue);
}

function parseFlowMap(s: string): { [k: string]: YamlValue } {
	const inner = s.slice(1, -1).trim();
	const obj: { [k: string]: YamlValue } = {};
	if (inner === '') return obj;
	for (const item of splitFlowItems(inner)) {
		const [key, val] = splitKeyValue(item);
		obj[key] = parseInlineValue(val);
	}
	return obj;
}

function splitFlowItems(s: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let inStr: '"' | "'" | null = null;
	let start = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (c === inStr && s[i - 1] !== '\\') inStr = null;
			continue;
		}
		if (c === '"' || c === "'") {
			inStr = c;
			continue;
		}
		if (c === '[' || c === '{') depth++;
		else if (c === ']' || c === '}') depth--;
		else if (c === ',' && depth === 0) {
			items.push(s.slice(start, i).trim());
			start = i + 1;
		}
	}
	if (start <= s.length) {
		const last = s.slice(start).trim();
		if (last !== '') items.push(last);
	}
	return items;
}

export function parseYaml(text: string): YamlValue {
	return new Parser(text).parseRoot();
}
