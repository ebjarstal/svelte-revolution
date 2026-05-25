<script lang="ts">
	import { t } from 'svelte-i18n';
	import toast from 'svelte-french-toast';
	import { applyAction, enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import nProgress from 'nprogress';

	import { pb } from '$lib/client/pocketbase';
	import type {
		Evidence,
		GraphNode,
		Scenario,
		Session,
		StateAxis,
		End
	} from '$types/pocketBase/TableTypes';
	import Button from '$components/Button.svelte';

	interface Props {
		session: Session;
		scenario: Scenario;
		currentNode: GraphNode | null;
		evidences: Evidence[];
		stateAxes: StateAxis[];
	}

	let { session, scenario, currentNode, evidences, stateAxes }: Props = $props();

	let text = $state('');
	let submitting = $state(false);

	const endRow = $derived(session.expand?.end as End | undefined);

	// Index labels par external_id pour rendre la sidebar lisible (l'état persisté
	// dans Session.evidences/scores utilise les external_ids — cf. design §3.2).
	const evidenceLabelByExternalId = $derived(
		new Map(evidences.map((e) => [e.external_id, e.label]))
	);
	const stateAxisLabelByExternalId = $derived(
		new Map(stateAxes.map((a) => [a.external_id, a.label]))
	);

	const unlockedEvidences = $derived(session.evidences ?? []);
	const scores: Record<string, number> = $derived(session.scores ?? {});
	const actionsLeft = $derived(session.actions_left);
	const warnings = $derived(session.warnings ?? 0);
</script>

<div class="min-h-screen w-full flex flex-col lg:flex-row gap-6 p-4 lg:p-8 bg-black text-gray-100">
	<main class="flex-1 flex flex-col gap-6 max-w-4xl mx-auto w-full">
		{#if session.completed && endRow}
			<section class="border border-gray-200/40 rounded-lg p-6 bg-gray-900/40">
				<h1 class="text-3xl font-bold mb-4">{$t('scripted.endReached')}</h1>
				<h2 class="text-xl font-semibold mb-3 text-gray-200">{endRow.title}</h2>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<p class="whitespace-pre-line leading-7 text-gray-300">{endRow.text}</p>
			</section>
		{:else if currentNode}
			<section class="border border-gray-200/30 rounded-lg p-6 bg-gray-900/30">
				{#if currentNode.title}
					<h1 class="text-2xl font-bold mb-4">{currentNode.title}</h1>
				{/if}
				<p class="whitespace-pre-line leading-7 text-gray-200">{currentNode.text}</p>
			</section>

			<form
				method="POST"
				action="?/addNode"
				use:enhance={() => {
					submitting = true;
					nProgress.start();
					return async ({ result }) => {
						submitting = false;
						nProgress.done();
						if (result.type === 'success') {
							const body = (result.data as { body?: { fell_back?: boolean; message?: string } } | undefined)?.body;
							if (body?.fell_back) {
								toast(
									$t('scripted.fallbackHint'),
									{ icon: '↻', position: 'top-center' }
								);
							}
							text = '';
							await invalidateAll();
						} else if (result.type === 'failure') {
							const err = (result.data as { error?: string } | undefined)?.error;
							toast.error(err ?? $t('scripted.errorGeneric'), { position: 'top-center' });
						} else {
							await applyAction(result);
						}
					};
				}}
				class="flex flex-col gap-3"
			>
				<input type="hidden" name="session" value={session.id} />
				<input type="hidden" name="pb_cookie" value={pb.authStore.exportToCookie()} />
				<textarea
					name="text"
					bind:value={text}
					placeholder={$t('scripted.inputPlaceholder')}
					class="w-full min-h-[120px] p-3 rounded border border-gray-200/40 bg-gray-900/60 text-gray-100 placeholder:text-gray-500 focus:border-gray-100 focus:outline-none"
					disabled={submitting}
					required
				></textarea>
				<div class="flex items-center justify-between">
					<span class="text-xs text-gray-500">
						{#if scenario.title}{scenario.title}{/if}
					</span>
					<Button
						type="submit"
						variant="primary"
						disabled={submitting || text.trim() === ''}
					>
						{$t('scripted.submit')}
					</Button>
				</div>
			</form>
		{:else}
			<section class="border border-gray-200/30 rounded-lg p-6 bg-gray-900/30 text-gray-300">
				<p>{$t('scripted.noCurrentNode')}</p>
			</section>
		{/if}
	</main>

	<aside class="lg:w-80 flex flex-col gap-4 lg:sticky lg:top-8 lg:self-start">
		{#if actionsLeft !== null && actionsLeft !== undefined}
			<div class="border border-gray-200/30 rounded p-4 bg-gray-900/30">
				<div class="text-xs uppercase tracking-wide text-gray-500 mb-1">
					{$t('scripted.actionsRemaining')}
				</div>
				<div class="text-2xl font-mono">{actionsLeft}</div>
			</div>
		{/if}

		{#if warnings > 0}
			<div class="border border-yellow-400/40 rounded p-4 bg-yellow-900/20">
				<div class="text-xs uppercase tracking-wide text-yellow-200/70 mb-1">
					{$t('scripted.warnings')}
				</div>
				<div class="text-2xl font-mono text-yellow-200">{warnings}</div>
			</div>
		{/if}

		{#if Object.keys(scores).length > 0}
			<div class="border border-gray-200/30 rounded p-4 bg-gray-900/30">
				<div class="text-xs uppercase tracking-wide text-gray-500 mb-2">
					{$t('scripted.scores')}
				</div>
				<ul class="flex flex-col gap-1 text-sm">
					{#each Object.entries(scores) as [axisId, value] (axisId)}
						<li class="flex justify-between">
							<span class="text-gray-300">
								{stateAxisLabelByExternalId.get(axisId) ?? axisId}
							</span>
							<span class="font-mono text-gray-100">{value}</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if unlockedEvidences.length > 0}
			<div class="border border-gray-200/30 rounded p-4 bg-gray-900/30">
				<div class="text-xs uppercase tracking-wide text-gray-500 mb-2">
					{$t('scripted.evidencesUnlocked')} ({unlockedEvidences.length})
				</div>
				<ul class="flex flex-col gap-1 text-sm text-gray-300">
					{#each unlockedEvidences as evidenceId (evidenceId)}
						<li class="leading-snug">
							{evidenceLabelByExternalId.get(evidenceId) ?? evidenceId}
						</li>
					{/each}
				</ul>
			</div>
		{/if}
	</aside>
</div>
