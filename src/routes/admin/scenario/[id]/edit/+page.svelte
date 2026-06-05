<script lang="ts">
	import { onMount } from 'svelte';
	import { t } from 'svelte-i18n';
	import toast from 'svelte-french-toast';
	import nProgress from 'nprogress';
	import { Save } from 'lucide-svelte';
	import { pb } from '$lib/client/pocketbase';
	import { ScriptGraph } from '$stores/graph/Classes/ScriptGraph.svelte';
	import Button from '$components/Button.svelte';
	import type { CompiledScript } from '$lib/scenario/compile';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	const scenario = $derived(data.scenario);

	// Deep copy so edits don't mutate the loaded record until saved. Only text/prose is editable;
	// the structure (ids, transitions, effects, flags) stays untouched, so the graph topology and
	// compiled classifier schemas remain valid and no recompilation is needed.
	const editScript: CompiledScript = $state(structuredClone(scenario.script as CompiledScript));

	let svg: SVGElement | null = $state.raw(null);
	let graph: ScriptGraph | null = $state.raw(null);
	let saving = $state(false);

	onMount(() => {
		if (!svg) return;
		graph = new ScriptGraph(svg, scenario.script as CompiledScript, { width: 500, height: 500 });
	});

	// Keep the graph node labels in sync with edited titles, without restarting the layout.
	$effect(() => {
		if (!graph) return;
		const titleById: Record<string, string> = {};
		for (const n of editScript.nodes) titleById[n.id] = n.title ?? n.id;
		for (const e of editScript.endings) titleById[e.id] = e.title;
		for (const node of graph._nodes) {
			const title = titleById[String(node.id)];
			if (title !== undefined) node.title = title;
		}
		graph.refreshLabels();
	});

	// Clicking a node in the graph focuses its form block. The synthetic global hub has no block.
	const selectedId = $derived.by(() => {
		if (!graph) return null;
		return graph.selectedNode?.id ?? null;
	});
	$effect(() => {
		if (selectedId === null) return;
		const block = document.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(String(selectedId))}"]`);
		if (!block) return;
		block.scrollIntoView({ behavior: 'smooth', block: 'center' });
		block.querySelector<HTMLInputElement>('input[type="text"]')?.focus({ preventScroll: true });
	});

	async function save() {
		saving = true;
		nProgress.start();
		try {
			const snapshot = $state.snapshot(editScript) as CompiledScript;
			const start = snapshot.nodes.find((n) => n.id === 'start');
			await pb.collection('Scenario').update(scenario.id, {
				title: snapshot.meta.title,
				prologue: snapshot.prologue,
				script: snapshot,
				firstNodeText: start?.text ?? scenario.firstNodeText,
				firstNodeTitle: start?.title ?? snapshot.meta.title
			});
			toast.success($t('admin.scenario.edit.saved'), { duration: 5000, position: 'bottom-center' });
		} catch (e) {
			console.error(e);
			toast.error($t('admin.scenario.edit.saveFailed'), { duration: 5000, position: 'bottom-center' });
		} finally {
			saving = false;
			nProgress.done();
		}
	}
</script>

<div class="flex flex-col items-center gap-4 py-4 text-white">
	<h1 class="text-3xl font-bold">{$t('admin.scenario.editScenario')}</h1>

	<div class="flex w-full max-w-6xl flex-col gap-6 px-4 lg:flex-row">
		<!-- Form -->
		<form class="flex w-full flex-col gap-6 lg:w-1/2" onsubmit={(e) => e.preventDefault()}>
			<!-- Title + prologue -->
			<section class="flex flex-col gap-2">
				<h2 class="text-2xl">{$t('admin.scenario.informations')}</h2>
				<label class="standardLabel">
					<span class="mb-1 block text-sm text-gray-400">{$t('admin.scenario.edit.title')}</span>
					<input class="w-full rounded bg-black/0 p-2" type="text" bind:value={editScript.meta.title} />
				</label>
				<label class="standardLabel">
					<span class="mb-1 block text-sm text-gray-400">{$t('admin.scenario.edit.prologue')}</span>
					<textarea class="block min-h-32 w-full rounded bg-black/0 p-2" bind:value={editScript.prologue}></textarea>
				</label>
			</section>

			<!-- Nodes -->
			<section class="flex flex-col gap-2">
				<h2 class="text-2xl">{$t('admin.scenario.edit.nodes')}</h2>
				{#each editScript.nodes as node (node.id)}
					<div
						class="standardLabel flex flex-col gap-2 {selectedId === node.id ? 'ring-2 ring-yellow-300' : ''}"
						data-node-id={node.id}
					>
						<span class="text-xs text-gray-500">{node.id}</span>
						<input
							class="w-full rounded bg-black/0 p-2"
							type="text"
							placeholder={$t('admin.scenario.edit.title')}
							bind:value={node.title}
						/>
						<textarea
							class="block min-h-24 w-full rounded bg-black/0 p-2"
							placeholder={$t('admin.scenario.edit.text')}
							bind:value={node.text}
						></textarea>
					</div>
				{/each}
			</section>

			<!-- Endings -->
			<section class="flex flex-col gap-2">
				<h2 class="text-2xl">{$t('admin.scenario.edit.endings')}</h2>
				{#each editScript.endings as ending (ending.id)}
					<div
						class="standardLabel flex flex-col gap-2 {selectedId === ending.id ? 'ring-2 ring-yellow-300' : ''}"
						data-node-id={ending.id}
					>
						<span class="text-xs text-gray-500">{ending.id}</span>
						<input
							class="w-full rounded bg-black/0 p-2"
							type="text"
							placeholder={$t('admin.scenario.edit.title')}
							bind:value={ending.title}
						/>
						<textarea
							class="block min-h-24 w-full rounded bg-black/0 p-2"
							placeholder={$t('admin.scenario.edit.text')}
							bind:value={ending.text}
						></textarea>
					</div>
				{/each}
			</section>

			<!-- Classifiers (advanced) -->
			<details class="standardLabel">
				<summary class="cursor-pointer text-2xl">{$t('admin.scenario.edit.classifiers')}</summary>
				<div class="mt-2 flex flex-col gap-4">
					{#each Object.entries(editScript.classifiers) as [id, classifier] (id)}
						<div class="flex flex-col gap-2 border-l border-gray-700 pl-2">
							<span class="text-xs text-gray-500">{id}</span>
							<label>
								<span class="mb-1 block text-sm text-gray-400">{$t('admin.scenario.edit.instructions')}</span>
								<textarea class="block min-h-24 w-full rounded bg-black/30 p-2" bind:value={classifier.instructions}></textarea>
							</label>
							<span class="text-sm text-gray-400">{$t('admin.scenario.edit.labels')}</span>
							{#each classifier.output.label as label (label.id)}
								<div class="flex flex-col gap-1">
									<span class="text-xs text-gray-500">{label.id}</span>
									<input
										class="w-full rounded bg-black/30 p-2"
										type="text"
										placeholder={$t('admin.scenario.edit.description')}
										bind:value={label.description}
									/>
								</div>
							{/each}
						</div>
					{/each}
				</div>
			</details>

			<Button class="text-lg" variant="primary" type="button" disabled={saving} onclick={save}>
				<span class="flex items-center gap-2"><Save class="h-5 w-5" /> {$t('admin.scenario.edit.save')}</span>
			</Button>
		</form>

		<!-- Graph -->
		<div class="flex w-full flex-col gap-2 lg:w-1/2">
			<h2 class="text-2xl">{$t('admin.scenario.edit.graph')}</h2>
			<svg
				bind:this={svg}
				width="500"
				height="500"
				class="sticky top-4 w-full rounded-md border border-white/20 bg-dotted-gray bg-dotted-40"
			></svg>
		</div>
	</div>
</div>

<style lang="postcss">
	@reference "../../../../../app.css";
	.standardLabel {
		@apply rounded-md border border-gray-200/20 bg-gray-950/50 p-4 shadow-lg backdrop-blur-[2px];
	}
</style>
