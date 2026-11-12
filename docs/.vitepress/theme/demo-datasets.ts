// The tech demo's datasets: each a graph with the shape of a real system, generated in the worker at the size picked,
// with what to colour by, searches on the drawing and queries to highlight. test/demo-datasets.test.ts runs every
// query on every dataset.
import type { DatasetRequest } from '../../../src/worker/protocol'
import type { GroupOf } from './versioned-drawing'

export interface DemoDataset {
  readonly name: DatasetRequest['name']
  /** In the Dataset menu. */
  readonly title: string
  /** The shape, in a few words, after the title. */
  readonly shape: string
  /** What a node is, for "Click a … to see …". */
  readonly noun: string
  /** The property nodes are coloured by, and how. */
  readonly groupKey: string
  readonly group: GroupOf
  /** Under the timeline: how it grew. */
  readonly grew: string
  /** Under the queries: what it is and where it comes from. */
  readonly about: string
  readonly searches: readonly string[]
  readonly queries: readonly { readonly title: string; readonly query: string }[]
}

const by = (fallback: (labels: readonly string[]) => string | undefined) => (labels: readonly string[], v: unknown) => fallback(labels) ?? String(v ?? '')

export const DEMO_DATASETS: readonly DemoDataset[] = [
  {
    name: 'network',
    title: 'Social network',
    shape: 'dense, communities and hubs',
    noun: 'person or a city',
    groupKey: 'community',
    group: by((l) => (l.includes('City') ? 'City' : undefined)),
    grew: 'The network as it grew, a person at a time',
    about: 'People make friends by preferential attachment: well-connected people make more, mostly within their community. Far more relationships than people.',
    searches: ['Bo 1', 'Yara', 'Kai 7', 'Lisbon'],
    queries: [
      { title: 'Two hops from Bo 1', query: "MATCH (:Person {name: 'Bo 1'})-[:KNOWS*1..2]-(f)\nRETURN DISTINCT f" },
      { title: 'Shortest path', query: "MATCH (a:Person {name: 'Bo 1'}), (b:Person {name: 'Gus 6'})\nMATCH p = shortestPath((a)-[:KNOWS*]-(b))\nRETURN p" },
      { title: 'The 50 most connected', query: 'MATCH (p:Person)-[:KNOWS]-(f)\nWITH p, count(f) AS friends\nORDER BY friends DESC LIMIT 50\nRETURN p' },
      { title: 'Everyone in Lisbon', query: "MATCH (p:Person)-[:LIVES_IN]->(:City {name: 'Lisbon'})\nRETURN p" },
      { title: 'Community 3', query: 'MATCH (p:Person {community: 3})\nRETURN p' },
      { title: 'Over 70 who know someone under 20', query: 'MATCH (a:Person)-[:KNOWS]-(b:Person)\nWHERE a.age > 70 AND b.age < 20\nRETURN a, b' },
    ],
  },
  {
    name: 'org-chart',
    title: 'Org chart',
    shape: 'a deep tree',
    noun: 'employee',
    groupKey: 'department',
    group: by(() => undefined),
    grew: 'The company as it grew, a hire at a time',
    about: 'A company: a CEO, VPs, directors, managers, leads and their teams. Everyone reports to one manager, so there are about as many relationships as people, and a few mentoring links across departments.',
    searches: ['Ada', 'Okafor', 'Tanaka'],
    queries: [
      { title: "The CEO's direct reports", query: 'MATCH (ceo:Employee {level: 0})<-[:REPORTS_TO]-(vp)\nRETURN ceo, vp' },
      { title: 'Chain of command of the newest hire', query: 'MATCH (e:Employee)\nWITH e ORDER BY id(e) DESC LIMIT 1\nMATCH p = (e)-[:REPORTS_TO*]->(:Employee {level: 0})\nRETURN p' },
      { title: 'All of Engineering', query: "MATCH (e:Employee {department: 'Engineering'})\nRETURN e" },
      { title: 'The 20 biggest teams', query: 'MATCH (m:Employee)<-[:REPORTS_TO]-(r)\nWITH m, count(r) AS team\nORDER BY team DESC LIMIT 20\nRETURN m' },
      { title: 'Mentoring across departments', query: 'MATCH (a)-[:MENTORS]->(b)\nWHERE a.department <> b.department\nRETURN a, b' },
    ],
  },
  {
    name: 'packages',
    title: 'Package dependencies',
    shape: 'a few huge hubs, many leaves',
    noun: 'package',
    groupKey: 'category',
    group: by(() => undefined),
    grew: 'The registry as it grew, a publish at a time',
    about: "A package registry like npm's: each package depends on a few earlier ones, and popular packages get picked far more often. A handful end up under thousands of others; most have no dependents.",
    searches: ['json', 'http', 'fast-'],
    queries: [
      { title: 'The 20 most depended on', query: 'MATCH (p:Package)<-[:DEPENDS_ON]-(d)\nWITH p, count(d) AS dependents\nORDER BY dependents DESC LIMIT 20\nRETURN p' },
      { title: 'What breaks if the top one does', query: 'MATCH (p:Package)<-[:DEPENDS_ON]-(d)\nWITH p, count(d) AS dependents\nORDER BY dependents DESC LIMIT 1\nMATCH (x)-[:DEPENDS_ON*1..2]->(p)\nRETURN DISTINCT x, p' },
      { title: 'Everything the neediest package pulls in', query: 'MATCH (p:Package)-[:DEPENDS_ON]->(d)\nWITH p, count(d) AS deps\nORDER BY deps DESC LIMIT 1\nMATCH (p)-[:DEPENDS_ON*1..4]->(x)\nRETURN DISTINCT p, x' },
      { title: 'Not MIT licensed', query: "MATCH (p:Package)\nWHERE p.license <> 'MIT'\nRETURN p" },
      { title: 'Testing packages', query: "MATCH (p:Package {category: 'testing'})\nRETURN p" },
    ],
  },
  {
    name: 'airline',
    title: 'Airline routes',
    shape: 'hub and spoke',
    noun: 'airport',
    groupKey: 'region',
    group: by(() => undefined),
    grew: 'The route network as it grew, an airport at a time',
    about: 'Hub airports fly to each other and to everywhere in their region; small airports fly to one or two nearby hubs. Stars, joined at their centres: any two airports are a few flights apart.',
    searches: ['International', 'AAA', 'ABC'],
    queries: [
      { title: 'The hubs', query: 'MATCH (h:Hub)\nRETURN h' },
      { title: 'Fewest flights from AAA to the newest airport', query: "MATCH (b:Airport)\nWITH b ORDER BY id(b) DESC LIMIT 1\nMATCH (a:Airport {code: 'AAA'})\nMATCH p = shortestPath((a)-[:ROUTE*]-(b))\nRETURN p" },
      { title: 'The 10 busiest airports', query: 'MATCH (a:Airport)-[:ROUTE]-(b)\nWITH a, count(b) AS routes\nORDER BY routes DESC LIMIT 10\nRETURN a' },
      { title: 'Everywhere in Europe', query: "MATCH (a:Airport {region: 'Europe'})\nRETURN a" },
      { title: 'Routes over 3,000 km', query: 'MATCH (a)-[r:ROUTE]->(b)\nWHERE r.km > 3000\nRETURN a, b' },
    ],
  },
  {
    name: 'power-grid',
    title: 'Power grid',
    shape: 'spread out, long paths',
    noun: 'substation or plant',
    groupKey: 'operator',
    group: by((l) => (l.includes('Plant') ? 'Plant' : undefined)),
    grew: 'The grid as it was built, outward from the centre, a substation at a time',
    about: 'Substations spread over a map, each linked to its neighbours by transmission lines, with power plants feeding the nearest one. Every node has a few links, and crossing the grid takes many.',
    searches: ['Central', 'plant', 'East 0'],
    queries: [
      { title: 'Power plants', query: 'MATCH (p:Plant)-[:FEEDS]->(s)\nRETURN p, s' },
      { title: 'From the centre to the edge', query: 'MATCH (a:Substation)\nWITH a ORDER BY id(a) LIMIT 1\nMATCH (b:Substation)\nWITH a, b ORDER BY id(b) DESC LIMIT 1\nMATCH p = shortestPath((a)-[:LINE*]-(b))\nRETURN p' },
      { title: 'Within 3 lines of the centre', query: 'MATCH (a:Substation)\nWITH a ORDER BY id(a) LIMIT 1\nMATCH (a)-[:LINE*1..3]-(n)\nRETURN DISTINCT a, n' },
      { title: 'The 400 kV backbone', query: 'MATCH (a)-[:LINE {kV: 400}]-(b)\nRETURN a, b' },
      { title: 'The East operator', query: "MATCH (s:Substation {operator: 'East'})\nRETURN s" },
    ],
  },
  {
    name: 'git-history',
    title: 'Git history',
    shape: 'long chains that fork and merge',
    noun: 'commit',
    groupKey: 'kind',
    group: by(() => undefined),
    grew: 'The repository as it grew, a commit at a time',
    about: 'Commits point to their parents. A long main line; feature and fix branches fork from it, run for a few commits and merge back (a merge has two parents), and a few are abandoned.',
    searches: ['Merge', 'Fix', 'login'],
    queries: [
      { title: 'The main line', query: "MATCH (c:Commit {branch: 'main'})\nRETURN c" },
      { title: 'Merges', query: 'MATCH (m:Merge)\nRETURN m' },
      { title: 'The last 40 commits before the latest', query: 'MATCH (c:Commit)\nWITH c ORDER BY id(c) DESC LIMIT 1\nMATCH p = (c)-[:PARENT*1..40]->(a)\nWHERE a.branch = \'main\'\nRETURN DISTINCT c, a' },
      { title: 'From the first commit to the latest', query: 'MATCH (a:Commit)\nWITH a ORDER BY id(a) LIMIT 1\nMATCH (b:Commit)\nWITH a, b ORDER BY id(b) DESC LIMIT 1\nMATCH p = shortestPath((b)-[:PARENT*]->(a))\nRETURN p' },
      { title: "ana's commits", query: "MATCH (c:Commit {author: 'ana'})\nRETURN c" },
    ],
  },
  {
    name: 'supply-chain',
    title: 'Supply chain',
    shape: 'tiers, four hops deep',
    noun: 'supplier, factory or store',
    groupKey: 'tier',
    group: by(() => undefined),
    grew: 'The supply chain as it was built, tier by tier',
    about: 'Raw material suppliers feed component makers, who feed factories, which ship to distribution centres, which stock stores. Most nodes are stores at the end; goods travel four hops to reach them.',
    searches: ['Lisbon', 'Assembly', 'Mining'],
    queries: [
      { title: "Where one store's goods come from", query: 'MATCH (s:Store)\nWITH s LIMIT 1\nMATCH p = (:Supplier)-[:SUPPLIES*4]->(s)\nRETURN p' },
      { title: 'Every store one factory reaches', query: 'MATCH (f:Factory)\nWITH f LIMIT 1\nMATCH (f)-[:SUPPLIES*2]->(s:Store)\nRETURN DISTINCT f, s' },
      { title: 'Raw material suppliers', query: 'MATCH (s:Supplier)\nRETURN s' },
      { title: 'Everything in Lisbon', query: "MATCH (n {city: 'Lisbon'})\nRETURN n" },
      { title: 'Lead times over 3 weeks', query: 'MATCH (a)-[r:SUPPLIES]->(b)\nWHERE r.leadDays > 21\nRETURN a, b' },
    ],
  },
  {
    name: 'microservices',
    title: 'Microservices',
    shape: 'tight clusters, few bridges',
    noun: 'service or database',
    groupKey: 'team',
    group: by(() => undefined),
    grew: 'The system as it grew, a deploy at a time',
    about: "Each team owns a gateway, services that call each other a lot, and a database. Teams call each other only now and then, through gateways: tight clusters joined by a few bridges.",
    searches: ['checkout', 'gateway', '-db'],
    queries: [
      { title: 'The checkout team', query: "MATCH (s {team: 'checkout'})\nRETURN s" },
      { title: 'Calls between teams', query: 'MATCH (a:Service)-[:CALLS]->(b:Service)\nWHERE a.team <> b.team\nRETURN a, b' },
      { title: 'What depends on payments-db', query: "MATCH (d:Database {name: 'payments-db'})<-[:USES]-(s)\nOPTIONAL MATCH (x)-[:CALLS*1..2]->(s)\nRETURN d, s, x" },
      { title: 'The 20 most called', query: 'MATCH (s:Service)<-[:CALLS]-(c)\nWITH s, count(c) AS callers\nORDER BY callers DESC LIMIT 20\nRETURN s' },
      { title: 'Databases and who uses them', query: 'MATCH (s)-[:USES]->(d:Database)\nRETURN s, d' },
    ],
  },
]
