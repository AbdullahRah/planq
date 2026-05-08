"use client";

import Image from "next/image";

export function TestimonialsSection() {
  return (
    <section id="about" className="bg-background">
      {/* Large Text Statement */}
      <div className="px-6 py-24 md:px-12 md:py-32 lg:px-20 lg:py-40">
        <p className="mx-auto max-w-5xl text-2xl leading-relaxed text-foreground md:text-3xl lg:text-[2.5rem] lg:leading-snug">
          We started planq because the same drawings get reviewed five times — by the architect,
          by the engineer, by the contractor, by the city, and eventually by the people pulling
          permits two years from now to renovate. Each review starts from scratch, finds the same
          kinds of problems, and adds weeks to the schedule. The code is a reference document. It
          deserves a tool that treats it like one.
        </p>
        <p className="mx-auto mt-8 max-w-5xl text-sm uppercase tracking-widest text-muted-foreground">
          Made by staqtech.
        </p>
      </div>

      {/* About Image */}
      <div className="relative aspect-[16/9] w-full">
        <Image
          src="https://images.unsplash.com/photo-1486325212027-8081e485255e?q=80&w=2400"
          alt="Architectural drawings spread across a desk"
          fill
          className="object-cover"
        />
        {/* Fade gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/60 to-transparent" />
      </div>
    </section>
  );
}
