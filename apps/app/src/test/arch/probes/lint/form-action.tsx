export function Go({ act }: { act: (data: FormData) => void }) {
  return (
    <form action={act}>
      <button type="submit">go</button>
    </form>
  );
}
