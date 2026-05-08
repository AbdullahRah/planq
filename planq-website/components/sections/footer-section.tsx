"use client";

import Link from "next/link";

const footerLinks = {
  product: [
    { label: "How it works", href: "#how-it-works" },
    { label: "What it finds", href: "#what-it-finds" },
    { label: "Industries", href: "#industries" },
    { label: "Examples", href: "#examples" },
  ],
  company: [
    { label: "About", href: "#about" },
    { label: "Roadmap", href: "#roadmap" },
    { label: "Contact", href: "mailto:hello@staqtech.com" },
  ],
  legal: [
    { label: "Privacy", href: "#" },
    { label: "Terms", href: "#" },
    { label: "Disclaimer", href: "#disclaimer" },
  ],
};

export function FooterSection() {
  return (
    <footer className="bg-background">
      {/* Main Footer Content */}
      <div className="border-t border-border px-6 py-16 md:px-12 md:py-20 lg:px-20">
        <div className="grid grid-cols-2 gap-12 md:grid-cols-4 lg:grid-cols-5">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1 lg:col-span-2">
            <Link href="/" className="text-lg font-medium text-foreground">
              planq
            </Link>
            <p className="mt-4 max-w-xs text-sm leading-relaxed text-muted-foreground">
              A code-aware first reviewer for building plans. Built on the 2020 NBC Alberta
              Edition. Made by staqtech.
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="mb-4 text-sm font-medium text-foreground">Product</h4>
            <ul className="space-y-3">
              {footerLinks.product.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="mb-4 text-sm font-medium text-foreground">Company</h4>
            <ul className="space-y-3">
              {footerLinks.company.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <h4 className="mb-4 text-sm font-medium text-foreground">Legal</h4>
            <ul className="space-y-3">
              {footerLinks.legal.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Disclaimer */}
        <div id="disclaimer" className="mt-16 max-w-3xl border-t border-border pt-8 text-xs leading-relaxed text-muted-foreground">
          planq is a self-review tool for design professionals. Use it before you submit, not
          instead of submitting. The municipality still has the final word. Final approval rests
          with the authority having jurisdiction.
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="border-t border-border px-6 py-6 md:px-12 lg:px-20">
        <div className="flex flex-col items-center justify-between gap-4 md:flex-row">
          <p className="text-xs text-muted-foreground">© 2026 staqtech. All rights reserved.</p>

          <div className="flex items-center gap-4">
            <Link
              href="https://staqtech.com"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              staqtech.com
            </Link>
            <Link
              href="mailto:hello@staqtech.com"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Email
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
