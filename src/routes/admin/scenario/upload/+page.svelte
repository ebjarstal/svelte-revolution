<script lang="ts">
	import { t } from 'svelte-i18n';
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { pb } from '$lib/client/pocketbase';
	import toast from 'svelte-french-toast';
	import nProgress from 'nprogress';
	import { CircleCheck, Download, Pencil, TriangleAlert, Upload } from 'lucide-svelte';
	import Button from '$components/Button.svelte';
	import type { ActionData } from './$types';

	interface Props {
		form: ActionData;
	}
	let { form }: Props = $props();

	let fileName = $state('');

	$effect(() => {
		if (form?.success) {
			toast.success($t('admin.scenario.uploadSuccess'), {
				duration: 8000,
				position: 'bottom-center'
			});
		} else if (form && 'error' in form && form.error) {
			toast.error(form.error, { duration: 5000, position: 'bottom-center' });
		}
	});
</script>

<div class="flex flex-col items-center gap-6 py-8 text-white">
	<h1 class="text-3xl font-bold">{$t('admin.scenario.uploadScenario')}</h1>
	<p class="max-w-xl text-center text-gray-300">{$t('admin.scenario.uploadHelp')}</p>

	<!-- Downloadable starter template (static asset, not a SvelteKit route) -->
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
	<a href="/scenario-template.yaml" download="scenario-template.yaml" class="flex items-center gap-2 rounded-md border border-white/20 px-4 py-2 hover:bg-white hover:text-black">
		<Download class="h-5 w-5" />
		{$t('admin.scenario.downloadTemplate')}
	</a>

	<!-- Succinct tutorial -->
	<details class="w-full max-w-xl rounded-md border border-gray-200/20 bg-gray-950/50 p-4">
		<summary class="cursor-pointer text-lg font-semibold">{$t('admin.scenario.tutoTitle')}</summary>
		<p class="mt-2 whitespace-pre-line text-sm text-gray-300">{$t('admin.scenario.tutoBody')}</p>
	</details>

	<form
		method="POST"
		enctype="multipart/form-data"
		use:enhance={() => {
			nProgress.start();
			return async ({ update }) => {
				await update({ reset: false });
				nProgress.done();
			};
		}}
		action="?/uploadScenario"
		class="flex w-full max-w-md flex-col items-center gap-4"
	>
		<label class="standardLabel flex w-full cursor-pointer flex-col items-center gap-2 text-center">
			<Upload class="h-8 w-8" />
			<span>{fileName || $t('admin.scenario.chooseYaml')}</span>
			<input
				class="hidden"
				type="file"
				name="file"
				accept=".yaml,.yml"
				required
				onchange={(e) => (fileName = e.currentTarget.files?.[0]?.name ?? '')}
			/>
		</label>

		<input type="hidden" name="pb_cookie" value={pb.authStore.exportToCookie()} />

		<Button class="text-lg" variant="primary" type="submit" disabled={!fileName}>
			{$t('admin.scenario.uploadButton')}
		</Button>
	</form>

	<div class="w-full max-w-xl">
		{#if form && 'issues' in form && form.issues && form.issues.length > 0}
			<div class="flex flex-col gap-4 rounded border border-gray-800 bg-gray-900 p-4">
				<h3 class="flex items-center justify-center gap-2 text-xl">
					<TriangleAlert class="h-7 w-7" />
					{$t('errors.scenario.notValid')}
					<TriangleAlert class="h-7 w-7" />
				</h3>
				<ul class="flex flex-col gap-2">
					{#each form.issues as issue (issue)}
						<li class="rounded bg-red-500 px-2 py-1 text-sm">{issue}</li>
					{/each}
				</ul>
			</div>
		{:else if form?.success}
			<div class="flex flex-col items-center gap-3 rounded-md border border-green-400 bg-green-600/90 p-5">
				<h3 class="flex items-center gap-2 text-center text-xl font-semibold">
					<CircleCheck class="h-7 w-7 shrink-0" />
					<span>{$t('admin.scenario.uploadSuccessTitle', { values: { title: form.title } })}</span>
				</h3>
				<a
					href={resolve('/admin/scenario/[id]/edit', { id: form.scenarioId })}
					class="flex items-center gap-2 rounded-md bg-white px-4 py-2 font-semibold text-black hover:bg-gray-200"
				>
					<Pencil class="h-5 w-5" />
					{$t('admin.scenario.openInEditor')}
				</a>
			</div>
		{/if}
	</div>
</div>

<style lang="postcss">
	@reference "../../../../app.css";
	.standardLabel {
		@apply rounded-md border border-gray-200/20 bg-gray-950/50 p-4 shadow-lg backdrop-blur-[2px];
	}
</style>
