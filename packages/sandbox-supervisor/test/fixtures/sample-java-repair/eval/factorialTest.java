public final class factorialTest {
    public static void main(String[] args) {
        if (Calculator.factorial(5) != 120) throw new AssertionError("factorial");
        if (Calculator.factorial(0) != 1) throw new AssertionError("factorial zero");
        System.out.println("factorial passed");
    }
}
