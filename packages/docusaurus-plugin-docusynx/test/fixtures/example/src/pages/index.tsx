import Link from '@docusaurus/Link';

function PathCard({title, to}: {title: string; to: string}) {
  return <Link to={to}><h2>{title}</h2></Link>;
}

export default function Home() {
  return <main><h1>Example Docs</h1><PathCard title="Documentation" to="/docs/introduction" /></main>;
}
