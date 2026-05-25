<script lang="ts">
	import { t } from 'svelte-i18n';
	import { enhance } from '$app/forms';
	import { pb } from '$lib/client/pocketbase';
	import Button from '$components/Button.svelte';
	import type { ActionData } from './$types';

	interface Props {
		form: ActionData;
	}
	let { form }: Props = $props();

	let submitting = $state(false);

	function fmtCounts(counts: NonNullable<Extract<ActionData, { success: true }>['counts']>): string {
		return $t('admin.scenario.import.successCounts', {
			values: {
				nodes: counts.nodes,
				characters: counts.characters,
				evidences: counts.evidences,
				stateAxes: counts.stateAxes,
				ends: counts.ends
			}
		});
	}
</script>

<div class="flex flex-col items-center gap-6 py-8 px-4 max-w-2xl mx-auto w-full">
	<h2 class="text-2xl font-thin text-center">{$t('admin.scenario.import.title')}</h2>
	<p class="text-gray-300 text-sm text-center">{$t('admin.scenario.import.description')}</p>

	{#if form?.success}
		<div class="w-full bg-green-950/50 border border-green-700 p-4 rounded-lg flex flex-col gap-3">
			<p class="text-green-300 font-medium">{$t('admin.scenario.import.successTitle')}</p>
			<p class="text-green-100 text-sm">{fmtCounts(form.counts)}</p>
			<p class="text-gray-400 text-xs font-mono break-all">id: {form.scenarioId}</p>
			<div class="flex gap-3 flex-wrap pt-1">
				<Button variant="primary" href="/admin/sessions/create?scenario={form.scenarioId}">
					{$t('admin.scenario.import.createSession')}
				</Button>
				<Button variant="ghost" href="/admin/scenario/import">
					{$t('admin.scenario.import.importAnother')}
				</Button>
			</div>
		</div>
	{:else if form && 'stage' in form}
		<div class="w-full bg-red-950/40 border border-red-700 p-4 rounded-lg flex flex-col gap-2">
			<p class="text-red-300 font-medium">
				{#if form.stage === 'auth'}{$t('admin.scenario.import.errorUnauthorized')}
				{:else if form.stage === 'missing'}{$t('admin.scenario.import.errorMissingFile')}
				{:else if form.stage === 'parse'}{$t('admin.scenario.import.errorParse')}
				{:else if form.stage === 'zod'}{$t('admin.scenario.import.errorZod')}
				{:else if form.stage === 'compile'}{$t('admin.scenario.import.errorCompile')}
				{:else if form.stage === 'refs'}{$t('admin.scenario.import.errorRefs')}
				{:else if form.stage === 'persist'}{$t('admin.scenario.import.errorPersist')}
				{/if}
			</p>
			{#if 'message' in form && form.message}
				<p class="text-red-100 text-sm font-mono break-words">{form.message}</p>
			{/if}
			{#if 'issues' in form && Array.isArray(form.issues)}
				<ul class="text-red-100 text-xs font-mono space-y-1 max-h-64 overflow-auto">
					{#each form.issues as issue, i (i)}
						<li class="break-words">
							{#if 'kind' in issue}
								<span class="text-red-400">{issue.kind}</span>
								<span class="text-gray-400">@</span>
								<span>{issue.path}</span>
								<span class="text-gray-400">→</span>
								<span class="text-red-300">{issue.ref}</span>
							{:else}
								<span>{issue.path}</span>
								<span class="text-gray-400">:</span>
								<span>{issue.message}</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<form
		method="POST"
		action="?/importFixture"
		enctype="multipart/form-data"
		class="flex flex-col gap-4 w-full"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
	>
		<input type="hidden" name="pb_cookie" value={pb.authStore.exportToCookie()} />

		<label class="flex flex-col gap-2">
			<span class="text-sm text-gray-300">{$t('admin.scenario.import.fileLabel')}</span>
			<input
				type="file"
				name="fixture"
				accept=".yaml,.yml,application/x-yaml,text/yaml"
				required
				class="bg-gray-950/50 border border-gray-200/20 rounded p-2 text-gray-100"
			/>
		</label>

		<div class="flex gap-3 items-center justify-end">
			<Button variant="ghost" href="/admin">{$t('admin.scenario.import.back')}</Button>
			<Button type="submit" variant="primary" disabled={submitting}>
				{$t('admin.scenario.import.submit')}
			</Button>
		</div>
	</form>
</div>
