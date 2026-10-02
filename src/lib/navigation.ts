// Sale del puente sin dejar esta página en el historial: volver atrás desde
// Stripe no vuelve a un enlace ya usado. Aparte para poder simularlo en tests.
export function leavePage(url: string): void {
  window.location.replace(url);
}
