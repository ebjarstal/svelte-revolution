<script lang="ts">
	import { t } from 'svelte-i18n';
	import { enhance } from '$app/forms';
	import { pb } from '$lib/client/pocketbase';
	import toast from 'svelte-french-toast';
	import nProgress from 'nprogress';
	import { Sparkles, TriangleAlert, Upload } from 'lucide-svelte';
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
			<div class="flex flex-col items-center rounded-md bg-green-500 p-4">
				<h3 class="flex items-center gap-2 text-xl font-semibold">
					<Sparkles class="h-7 w-7" />
					<span>{form.title}</span>
					<Sparkles class="h-7 w-7" />
				</h3>
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
