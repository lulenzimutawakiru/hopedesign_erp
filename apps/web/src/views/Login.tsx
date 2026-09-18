/**
 * Compatibility shim.
 *
 * The sign-in surface moved to `src/signin/` when the page was rebuilt on the
 * full-screen industrial composition (branded shell + compact credential
 * panel). This module stays behind so existing imports of `views/Login`
 * keep working and so the router never has to know the page moved.
 */
export { LoginPage as default, LoginPage } from '../signin/LoginPage';
