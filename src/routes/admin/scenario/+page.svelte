<script lang="ts">
	import { t } from 'svelte-i18n';
	import { resolve } from '$app/paths';
	import { Pencil } from 'lucide-svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<div class="flex flex-col items-center gap-4 py-4 text-white">
	<h1 class="text-3xl font-bold">{$t('admin.scenario.yourScenarios')}</h1>

	<div class="flex w-full max-w-3xl flex-col gap-2 px-4">
		{#if data.scenarios.length === 0}
			<p class="text-center text-gray-400">{$t('admin.scenario.noScenarios')}</p>
		{/if}
		{#each data.scenarios as scenario (scenario.id)}
			<div class="flex items-center justify-between gap-4 rounded-md border border-gray-200/20 bg-gray-950/50 p-4 shadow-lg backdrop-blur-[2px]">
				<div class="flex flex-col">
					<span class="text-lg font-semibold">{scenario.title}</span>
					<span class="flex gap-2 text-xs text-gray-400">
						<span>{(scenario.lang ?? '').toUpperCase()}</span>
						<span>·</span>
						<span>{scenario.engine ?? 'legacy'}</span>
					</span>
				</div>
				{#if scenario.engine === 'gamemaster'}
					<a
						href={resolve('/admin/scenario/[id]/edit', { id: scenario.id })}
						class="flex items-center gap-2 rounded-md border border-white/20 px-4 py-2 hover:bg-white hover:text-black"
					>
						<Pencil class="h-4 w-4" />
						{$t('admin.scenario.editScenario')}
					</a>
				{/if}
			</div>
		{/each}
	</div>
</div>
