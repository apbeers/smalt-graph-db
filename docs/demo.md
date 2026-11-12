---
layout: page
title: Tech demo
sidebar: false
aside: false
---

<div class="cy-demo-page">

<h1 class="cy-demo-title">Tech demo: graphs on the GPU, small and big</h1>

<p class="cy-demo-lead">A generated social network of 50 to 100,000 people, drawn whole in 2D or 3D. Pick a small one to
read every name and click a person for their details and connections, or a big one to see the engine and the renderer
at scale. Search the drawing or run a query: its result lights up inside the whole graph. The numbers show what each
step took, on your machine. For results as tables, use the <a href="./playground">playground</a>.</p>

<ClientOnly>
  <TechDemo />
</ClientOnly>

</div>

<style>
.cy-demo-page { padding: 24px; }
.cy-demo-title { font-size: 28px; font-weight: 700; letter-spacing: -0.02em; margin: 0 0 6px; }
.cy-demo-lead { max-width: 70ch; color: var(--vp-c-text-2); margin: 0 0 16px; }
.cy-demo-lead a { color: var(--vp-c-brand-1); text-decoration: underline; }
@media (max-width: 640px) { .cy-demo-page { padding: 16px; } }
</style>
